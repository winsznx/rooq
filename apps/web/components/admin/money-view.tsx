"use client";

import type { AdminFees, AdminMoney, AdminVault, AssetAmount } from "@rooq/private-sdk/admin";
import { StateBlock } from "@/components/primitives";
import { useAdminFees, useAdminMoney, useAdminRange, useAdminVault } from "@/lib/admin/hooks";
import styles from "@/app/admin/admin.module.css";
import { ETH_FORMAT, USD_FORMAT } from "./chart-formats";
import { assetAmount, eth, sharePct, usd } from "./format";
import { Kpi, KpiStrip } from "./kpi";
import { MoneyHero, SlicePanel, VaultPanel } from "./money-panels";
import { AdminPageHead } from "./page-head";
import { RANGE_LABEL } from "./range-label";
import { assetLabel } from "./slices";
import { TimeChart } from "./time-chart";

type Flow = AssetAmount & { usd: number };

interface AssetFlow {
  readonly asset: `0x${string}`;
  readonly label: string;
  readonly in: Flow | null;
  readonly out: Flow | null;
}

/** One row per asset with its in and out side by side, largest dollar volume first. */
function byAsset(money: AdminMoney): AssetFlow[] {
  const rows = new Map<string, { asset: `0x${string}`; label: string; in: Flow | null; out: Flow | null }>();
  for (const a of money.byAsset) {
    const key = a.asset.toLowerCase();
    const row = rows.get(key) ?? { asset: a.asset, label: assetLabel(a), in: null, out: null };
    row[a.direction] = a;
    rows.set(key, row);
  }
  const volume = (r: AssetFlow): number => (r.in?.usd ?? 0) + (r.out?.usd ?? 0);
  return [...rows.values()].sort((a, b) => volume(b) - volume(a));
}

function AssetFlowsTable({ money }: { money: AdminMoney }): React.JSX.Element {
  const rows = byAsset(money);
  if (rows.length === 0) return <StateBlock kind="empty" title="Nothing shielded or unshielded in this range" body="Pick a longer range, or check back once the indexer has caught up." />;
  return (
    <div className="table-scroll">
      <table className="table">
        <caption className="sr-only">Shielded and unshielded amounts per asset, with their dollar value</caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col" className="n">
              In
            </th>
            <th scope="col" className="n">
              In, dollars
            </th>
            <th scope="col" className="n">
              Out
            </th>
            <th scope="col" className="n">
              Out, dollars
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.asset}>
              <th scope="row">{r.label}</th>
              <td className="n">{r.in ? assetAmount(r.in) : "None"}</td>
              <td className="n">{r.in ? usd(r.in.usd) : usd(0)}</td>
              <td className="n">{r.out ? assetAmount(r.out) : "None"}</td>
              <td className="n">{r.out ? usd(r.out.usd) : usd(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RelayerFeesTable({ fees }: { fees: AdminFees }): React.JSX.Element {
  if (fees.relayerFees.length === 0) return <StateBlock kind="empty" title="No relayer fees in this range" />;
  return (
    <div className="table-scroll">
      <table className="table">
        <caption className="sr-only">Relayer fees taken from unshields, per asset</caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col" className="n">
              Fees
            </th>
            <th scope="col" className="n">
              Dollars
            </th>
          </tr>
        </thead>
        <tbody>
          {fees.relayerFees.map((f) => (
            <tr key={f.asset}>
              <th scope="row">{assetLabel(f)}</th>
              <td className="n">{assetAmount(f)}</td>
              <td className="n">{f.usd === null ? "Not priced" : usd(f.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingsTable({ vault }: { vault: AdminVault }): React.JSX.Element {
  if (vault.assets.length === 0) return <StateBlock kind="empty" title="The vault holds nothing yet" />;
  const rows = [...vault.assets].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  return (
    <div className="table-scroll">
      <table className="table">
        <caption className="sr-only">Every asset the custody contract holds now</caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col" className="n">
              Held
            </th>
            <th scope="col" className="n">
              Dollars
            </th>
            <th scope="col" className="n">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.asset}>
              <th scope="row">{assetLabel(a)}</th>
              <td className="n">{assetAmount(a)}</td>
              <td className="n">{a.usd === null ? "Not priced" : usd(a.usd)}</td>
              <td className="n">{a.usd === null ? "Not priced" : sharePct(a.sharePct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MoneyView(): React.JSX.Element {
  const range = useAdminRange();
  const money = useAdminMoney(range);
  const fees = useAdminFees(range);
  const vault = useAdminVault();
  const m = money.data?.totals;
  const f = fees.data;
  return (
    <>
      <AdminPageHead
        title="Money"
        lede={`${RANGE_LABEL[range]}. USDG counts as one dollar. Stock Tokens are valued at their testnet oracle answer for the hour they moved. Amounts are public shield and unshield events, never balances inside the pool.`}
      />
      <MoneyHero query={money} />
      <KpiStrip label="Money and fee totals" columns={5}>
        <Kpi label="In" value={m ? usd(m.inUsd) : undefined} sub="Shielded in range" trend={money.data?.series.in} />
        <Kpi label="Out" value={m ? usd(m.outUsd) : undefined} sub="Unshielded in range" trend={money.data?.series.out} />
        <Kpi label="Net in" value={m ? usd(m.inUsd - m.outUsd) : undefined} sub="In minus out" />
        <Kpi label="Relayer fees" value={f ? usd(f.relayerFeesUsd) : undefined} sub="Taken from unshields" trend={f?.relayerFeesSeries} />
        <Kpi label="Gas spent" value={f ? eth(f.operatorGasWei) : undefined} sub={f ? `Relayer ${eth(f.relayerGasWei, 5)}` : undefined} trend={f?.operatorGasSeries} />
      </KpiStrip>
      <div className={styles.split}>
        <SlicePanel title="Relayer fees" query={fees}>
          {(data) => (
            <>
              <TimeChart
                title="Relayer fees in dollars"
                bucket={data.bucket}
                format={USD_FORMAT}
                plain
                series={[{ id: "fees", label: "Fees", tone: "accent", kind: "bar", points: data.relayerFeesSeries }]}
              />
              <RelayerFeesTable fees={data} />
            </>
          )}
        </SlicePanel>
        <SlicePanel title="Operator gas" query={fees}>
          {(data) => (
            <>
              <TimeChart
                title="Gas spent by all operator wallets, in ETH"
                bucket={data.bucket}
                format={ETH_FORMAT}
                plain
                series={[{ id: "gas", label: "Gas", tone: "muted", kind: "bar", points: data.operatorGasSeries }]}
              />
              <p
                className={styles.tableNote}
              >{`All operator wallets together, ${eth(data.operatorGasWei, 5)} in range. The relayer's share, ${eth(data.relayerGasWei, 5)}, is what relayer fees pay for.`}</p>
            </>
          )}
        </SlicePanel>
      </div>
      <SlicePanel title="By asset" query={money} meta={(d) => (d.unpriced > 0 ? `${d.unpriced} unpriced` : null)}>
        {(data) => <AssetFlowsTable money={data} />}
      </SlicePanel>
      <div className={styles.split}>
        <VaultPanel query={vault} />
        <SlicePanel title="Every holding" query={vault}>
          {(data) => <HoldingsTable vault={data} />}
        </SlicePanel>
      </div>
    </>
  );
}
