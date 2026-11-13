"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatAge } from "@rooq/sdk";
import { AssetEmblem } from "@/components/primitives";
import { useChainNow } from "@/lib/use-now";
import { CHAIN_CONFIG, ENV, ENV_LABEL } from "@/lib/env";
import { PRIVATE_READ_URL, PRIVATE_RELAYER_URL } from "@/lib/private/config";
import { marketArtwork } from "@/lib/private/assets";

/** The read API is behind once it trails the chain by this many blocks. */
const MAX_LAG_BLOCKS = 50n;
/** Risk workers post a funding epoch every 30 minutes; two missed epochs means they're not keeping up. */
const MAX_EPOCH_AGE_S = 3_900;

interface SyncStatus {
  readonly lagBlocks: string;
  readonly syncedBlock: string;
}

interface MarketStatus {
  readonly market: string;
  readonly closeOnly: boolean;
  readonly markFresh: boolean;
  readonly markUpdatedAt: string;
  readonly funding: { readonly lastEpoch: string };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

function MarketEmblem({ market }: { market: string }) {
  const art = marketArtwork(BigInt(market));
  return <AssetEmblem logoUrl={art.logoUrl} assetClass={art.assetClass} size={24} label={art.label} />;
}

function Row({ label, ok, value, detail }: { label: string; ok: boolean | null; value: string; detail?: string }) {
  return (
    <tr>
      <th scope="row" style={{ height: 52 }}>
        {label}
      </th>
      <td>
        <span className="pill" data-tone={ok === null ? "neutral" : ok ? "positive" : "warning"}>
          {ok === null ? "Checking" : ok ? "Operational" : "Degraded"}
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
  const rpc = useQuery({
    queryKey: ["status-rpc"],
    enabled: Boolean(client),
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!client) return null;
      const t0 = performance.now();
      const block = await client.getBlock();
      return { latencyMs: Math.round(performance.now() - t0), number: block.number };
    },
  });
  const sync = useQuery({ queryKey: ["status-sync"], refetchInterval: 10_000, retry: 0, queryFn: () => getJson<SyncStatus>(`${PRIVATE_READ_URL}/v1/sync`) });
  const relayer = useQuery({ queryKey: ["status-relayer"], refetchInterval: 15_000, retry: 0, queryFn: () => getJson<{ address: unknown }>(`${PRIVATE_RELAYER_URL}/v1/relayer`) });
  const markets = useQuery({ queryKey: ["status-markets"], refetchInterval: 15_000, retry: 0, queryFn: async () => (await getJson<{ markets: MarketStatus[] }>(`${PRIVATE_READ_URL}/v1/markets`)).markets });

  const refresh = () => {
    void rpc.refetch();
    void sync.refetch();
    void relayer.refetch();
    void markets.refetch();
  };

  const age = (unix: string) => (chainNow === null ? null : chainNow - Number(unix));
  const label = (m: MarketStatus) => marketArtwork(BigInt(m.market)).label;
  const syncOk = sync.isError ? false : sync.data ? BigInt(sync.data.lagBlocks) <= MAX_LAG_BLOCKS : null;
  const relayerOk = relayer.isError ? false : relayer.data ? relayer.data.address !== null : null;
  const epochAges = (markets.data ?? []).map((m) => age(m.funding.lastEpoch)).filter((a): a is number => a !== null);
  const oldestEpoch = epochAges.length > 0 ? Math.max(...epochAges) : null;
  const riskOk = markets.isError ? false : oldestEpoch === null ? null : oldestEpoch <= MAX_EPOCH_AGE_S;
  const staleMarkets = (markets.data ?? []).filter((m) => !m.markFresh);

  const degraded: { key: string; title: string; body: string }[] = [];
  if (rpc.isError) degraded.push({ key: "rpc", title: "Trading is blocked", body: "The RPC isn't answering, so balances and prices can't be read. Nothing is signed until they can." });
  if (syncOk === false) degraded.push({ key: "sync", title: "Balances load slowly", body: "The read API is behind or offline. The app rebuilds your account from chain data instead, which takes longer." });
  if (relayerOk === false) degraded.push({ key: "relayer", title: "Private actions are waiting", body: "The relayer can't be reached. Unshielding still works if your own wallet pays the gas." });
  if (riskOk === false) degraded.push({ key: "risk", title: "Risk checks are behind", body: "Funding epochs are late, so unhealthy positions may wait longer to be liquidated." });
  if (staleMarkets.length > 0) degraded.push({ key: "stale", title: `${staleMarkets.map(label).join(", ")}: price delayed`, body: "New positions are paused in these markets. Closing stays available." });

  return (
    <div className="stack" style={{ "--gap": "24px" } as React.CSSProperties}>
      <section aria-label="What is affected" style={{ borderTop: "2px solid var(--rq-ink)", paddingTop: 12 }}>
        <h2 className="t-section" style={{ marginBottom: 8 }}>{degraded.length === 0 ? "Trading is available" : "Some things are affected"}</h2>
        {degraded.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Swaps, perps, liquidity and private transfers are all responding. These checks run on this page now.</p>
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
            <Row label="Chain RPC" ok={rpc.isError ? false : rpc.data ? true : null} value={rpc.data ? `block ${rpc.data.number.toString()}, ${rpc.data.latencyMs} ms` : "—"} detail={rpc.isError ? "The RPC isn't answering. Trading actions are blocked until state can be read." : undefined} />
            <Row label="Read API" ok={syncOk} value={sync.data ? `${sync.data.lagBlocks} blocks behind` : sync.isError ? "offline" : "—"} detail="Serves the note tree and market data so accounts load fast. Your account can always be rebuilt from chain data without it." />
            <Row label="Relayer" ok={relayerOk} value={relayer.data ? "accepting" : relayer.isError ? "offline" : "—"} detail="Submits private actions so your wallet never appears on them." />
            <Row label="Risk workers" ok={riskOk} value={oldestEpoch !== null ? `funding epoch ${formatAge(oldestEpoch)}` : markets.isError ? "unknown" : "—"} detail="Two risk workers, each with its own key, post funding and liquidate unhealthy positions while traders are offline." />
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
                Funding epoch
              </th>
            </tr>
          </thead>
          <tbody>
            {(markets.data ?? []).map((m) => (
              <tr key={m.market}>
                <th scope="row">
                  <span className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
                    <MarketEmblem market={m.market} />
                    {label(m)}
                  </span>
                </th>
                <td>
                  <span className="pill" data-tone={m.closeOnly ? "warning" : m.markFresh ? "positive" : "warning"}>
                    {m.closeOnly ? "Close only" : m.markFresh ? "Open" : "Price delayed"}
                  </span>
                </td>
                <td className={`n ${m.markFresh ? "" : "warn"}`}>{formatAge(age(m.markUpdatedAt))}</td>
                <td className="n">{formatAge(age(m.funding.lastEpoch))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
