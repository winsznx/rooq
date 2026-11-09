"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatAge, formatFixed } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { useMarketSnapshots } from "@/lib/chain-data";
import { useApiHealth } from "@/lib/api-hooks";
import { useChainNow } from "@/lib/use-now";
import { CHAIN_CONFIG, ENV, ENV_LABEL, MAKER_URL } from "@/lib/env";
import { PerpStatusPill } from "@/components/primitives";

function Row({ label, ok, value, detail }: { label: string; ok: boolean | null; value: string; detail?: string }) {
  return (
    <tr>
      <th scope="row" style={{ height: 52 }}>
        {label}
      </th>
      <td>
        <span className="pill" data-tone={ok === null ? "neutral" : ok ? "positive" : "warning"}>
          {ok === null ? "Unknown" : ok ? "Operational" : "Degraded"}
        </span>
      </td>
      <td className="num t-small">{value}</td>
      <td className="t-small muted" style={{ whiteSpace: "normal" }}>
        {detail ?? ""}
      </td>
    </tr>
  );
}

export function StatusView() {
  const client = usePublicClient();
  const chainNow = useChainNow();
  const markets = useMarketSnapshots();
  const api = useApiHealth();
  const rpc = useQuery({
    queryKey: ["status-rpc"],
    enabled: Boolean(client),
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!client) return null;
      const t0 = performance.now();
      const block = await client.getBlock();
      return { latencyMs: Math.round(performance.now() - t0), number: block.number, timestamp: Number(block.timestamp) };
    },
  });
  const maker = useQuery({
    queryKey: ["status-maker"],
    refetchInterval: 10_000,
    retry: 0,
    queryFn: async () => {
      const res = await fetch(`${MAKER_URL}/health`, { signal: AbortSignal.timeout(5_000) });
      return (await res.json()) as { status: string; maker: string };
    },
  });

  const refresh = () => {
    void rpc.refetch();
    void maker.refetch();
    void api.refetch();
    void markets.refetch();
  };

  const degraded: { key: string; title: string; body: string }[] = [];
  if (rpc.isError) degraded.push({ key: "rpc", title: "Trading is blocked", body: "The RPC is not answering, so balances and prices can't be read. Nothing is signed until they can." });
  if (api.isError) degraded.push({ key: "api", title: "Charts and history are unavailable", body: "Trading, balances and prices still work; they come straight from the chain." });
  if (maker.isError) degraded.push({ key: "maker", title: "New perp quotes are unavailable", body: "Existing positions are unaffected. Spot trades through the pool still work." });
  const staleMarkets = (markets.data ?? []).filter((m) => m.hasPerps && !m.markFresh);
  if (staleMarkets.length > 0) degraded.push({ key: "stale", title: `${staleMarkets.map((m) => m.base.symbol).join(", ")}: price delayed`, body: "New positions are paused in these markets. Closing stays available." });

  return (
    <div className="stack" style={{ "--gap": "24px" } as React.CSSProperties}>
      <section aria-label="What is affected" style={{ borderTop: "2px solid var(--rq-ink)", paddingTop: 12 }}>
        <h2 className="t-section" style={{ marginBottom: 8 }}>{degraded.length === 0 ? "Trading is available" : "Some things are affected"}</h2>
        {degraded.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Spot, perps, charts and history are all responding. These checks run on this page now; they are not an uptime guarantee.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }} role="list">
            {degraded.map((d) => (
              <li key={d.key}>
                <strong>{d.title}</strong>
                <span className="muted" style={{ display: "block", fontSize: 14 }}>{d.body}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="row between wrap">
        <p className="muted" style={{ margin: 0 }}>{`${ENV_LABEL[ENV]}, chain ID ${CHAIN_CONFIG.chainId}. Every value below is measured now. None of it is a guarantee of uptime.`}</p>
        <button type="button" className="btn" onClick={refresh}>
          Refresh
        </button>
      </div>
      <div className="panel table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">State</th>
              <th scope="col">Measured</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Chain RPC" ok={rpc.isError ? false : rpc.data ? true : null} value={rpc.data ? `block ${rpc.data.number.toString()}, ${rpc.data.latencyMs} ms` : "—"} detail={rpc.isError ? "The RPC is not answering. Trading actions are blocked until state can be read." : undefined} />
            <Row
              label="Indexer and API"
              ok={api.isError ? false : api.data ? api.data.indexer.status === "ok" : null}
              value={api.data ? `${api.data.indexer.lagBlocks ?? "—"} blocks behind` : api.isError ? "offline" : "—"}
              detail={api.isError ? "History and charts are unavailable. Balances and prices still come from the chain." : (api.data?.indexer.reason ?? undefined)}
            />
            <Row label="Maker quote service" ok={maker.isError ? false : maker.data ? maker.data.status === "quoting" : null} value={maker.data?.status ?? (maker.isError ? "offline" : "—")} detail={maker.isError ? copy.perps.noLiquidity : undefined} />
            <Row label="Risk workers" ok={null} value="not shown here" detail="Two risk workers, each with its own key, liquidate unhealthy positions while traders are offline." />
          </tbody>
        </table>
      </div>

      <p className="t-small faint" style={{ margin: 0 }}>Prices on this deployment come from a single-operator testnet relay.</p>
      <h2 className="t-section">Markets</h2>
      <div className="panel table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Perps</th>
              <th scope="col" className="n">
                Price updated
              </th>
              <th scope="col" className="n">
                Maker backing / minimum
              </th>
              <th scope="col" className="n">
                Unpaid losses
              </th>
            </tr>
          </thead>
          <tbody>
            {(markets.data ?? []).map((m) => (
              <tr key={m.marketId}>
                <th scope="row">{m.base.symbol}</th>
                <td>{m.hasPerps ? <PerpStatusPill status={m.perpStatus} fresh={m.markFresh} /> : <span className="tag">Spot only</span>}</td>
                <td className={`n ${m.hasPerps && !m.markFresh ? "warn" : ""}`}>{m.markUpdatedAt !== null && chainNow !== null ? formatAge(chainNow - m.markUpdatedAt) : "—"}</td>
                <td className="n">{m.risk ? `${formatFixed(m.makerBacking, m.quote.decimals, 0)} / ${formatFixed(m.risk.minMakerBacking, m.quote.decimals, 0)} ${m.quote.symbol}` : "—"}</td>
                <td className={`n ${m.badDebt > 0n ? "neg" : ""}`}>{`${formatFixed(m.badDebt, m.quote.decimals, 2)} ${m.quote.symbol}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
