"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { decodeEventLog, erc20Abi, type Abi, type Hex, type TransactionReceipt } from "viem";
import { formatFixed, parseDecimal } from "@rooq/sdk";
import { AmountField } from "@/components/funds/amount-field";
import { TxProgress } from "@/components/feedback/tx-progress";
import { StateBlock } from "@/components/primitives";
import { WalletGate } from "@/components/wallet";
import { useTxRunner } from "@/lib/tx";
import { MARKETS_ABI } from "@/lib/private/chain-state-abi";
import { privatePublicClient } from "@/lib/private/public-client";
import type { PrivateView, TierView } from "@/lib/private/types";
import { amountText, Line, Offline, PageHead, styles, TokenIcon, tokenOf, useView } from "./kit";

const leverage = (t: TierView) => `${(1e18 / Number(t.imrWad)).toFixed(1)}x`;
const usd = (wad: bigint) => `$${formatFixed(wad, 18, 0)}`;

function Created({ id, view, bond, feedLabel }: { id: bigint; view: PrivateView; bond: bigint; feedLabel: string }) {
  const c = view.create!;
  return (
    <section className={styles.card} data-testid="market-created">
      <h2 className={styles.cardTitle}>{`Market ${id} is live`}</h2>
      <p className={styles.note}>{`${feedLabel} private perps now exist on chain. Traders need maker backing before anything can open.`}</p>
      <Line label="Market">{id.toString()}</Line>
      <Line label="Price feed">{feedLabel}</Line>
      <Line label="Bond posted">{amountText(view, c.collateral, bond, 2)}</Line>
      <div className={styles.row}>
        <Link href="/app/makers" className="btn btn-primary btn-sm">Back this market</Link>
        <Link href="/app/markets" className="btn btn-sm">Markets</Link>
      </div>
    </section>
  );
}

function Form({ view }: { view: PrivateView }) {
  const c = view.create!;
  const { address } = useAccount();
  const [tierId, setTierId] = useState(0);
  const [feed, setFeed] = useState<string>(c.feeds.find((f) => f.approved && !f.taken)?.id ?? "");
  const [oiText, setOiText] = useState("");
  const [bondText, setBondText] = useState("");
  const [created, setCreated] = useState<{ id: bigint; bond: bigint; label: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { run, steps, busy, reset } = useTxRunner(privatePublicClient);
  const tier = c.tiers[tierId] ?? c.tiers[0];
  const token = tokenOf(view, c.collateral);
  const bond = parseDecimal(bondText, token.decimals);
  const oi = parseDecimal(oiText, 18);
  const chosen = useMemo(() => c.feeds.find((f) => f.id === feed), [c.feeds, feed]);
  if (!tier) return <StateBlock kind="unavailable" title="This deployment has no market tiers" />;
  const bondLow = bond !== null && bond < tier.minBond;
  const oiHigh = oi !== null && oi > tier.maxOiUsdWad;
  const ready = bond !== null && !bondLow && oi !== null && oi > 0n && !oiHigh && /^0x[0-9a-fA-F]{64}$/.test(feed);
  if (created) return <Created id={created.id} view={view} bond={created.bond} feedLabel={created.label} />;
  const go = async () => {
    if (!ready || bond === null || oi === null || !address) return;
    setProblem(null);
    reset();
    const allowance = await privatePublicClient.readContract({ address: c.collateral, abi: erc20Abi, functionName: "allowance", args: [address, c.module] });
    const label = chosen?.label ?? `${feed.slice(0, 8)}…`;
    const receipts: TransactionReceipt[] | null = await run(
      [
        ...(allowance < bond ? [{ label: `Approve ${token.symbol} bond`, address: c.collateral, abi: erc20Abi as Abi, functionName: "approve", args: [c.module, bond] as const }] : []),
        { label: `Create ${label} market`, address: c.module, abi: MARKETS_ABI as Abi, functionName: "createMarket", args: [BigInt(tier.id), feed as Hex, oi, bond] as const },
      ],
      { title: `Create ${label} market`, kind: "market", icons: [{ asset: c.collateral }] },
    );
    if (!receipts) {
      setProblem("The market wasn't created. The steps above say which part stopped.");
      return;
    }
    for (const log of receipts.at(-1)!.logs) {
      if (log.address.toLowerCase() !== c.module.toLowerCase()) continue;
      const decoded = decodeEventLog({ abi: MARKETS_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "MarketCreated") setCreated({ id: decoded.args.market, bond, label });
    }
  };
  return (
    <section className={styles.card} aria-label="Create a market" style={{ maxWidth: 640 }}>
      <div className={styles.stack}>
        <span className="field-label"><span>Risk tier</span></span>
        <div className={styles.row}>
          {c.tiers.map((t) => (
            <button key={t.id} type="button" className="chip" aria-pressed={t.id === tierId} onClick={() => setTierId(t.id)}>{`${leverage(t)} max`}</button>
          ))}
        </div>
        <Line label="Taker fee">{`${Number(tier.takerFeeBps) / 100}%`}</Line>
        <Line label="Liquidation penalty">{`${Number(tier.penaltyBps) / 100}%`}</Line>
        <Line label="Open interest limit">{`Up to ${usd(tier.maxOiUsdWad)}`}</Line>
        <Line label="Minimum bond"><span className={styles.row}><TokenIcon view={view} asset={c.collateral} />{amountText(view, c.collateral, tier.minBond, 2)}</span></Line>
      </div>
      <div className={styles.stack}>
        <span className="field-label"><span>Price feed</span></span>
        <div className={styles.row}>
          {c.feeds.map((f) => (
            <button key={f.id} type="button" className="chip" disabled={!f.approved || f.taken} aria-pressed={f.id === feed} onClick={() => setFeed(f.id)}>{`${f.label}${f.taken ? " (taken)" : !f.approved ? " (not approved)" : ""}`}</button>
          ))}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="feed-id"><span>Feed ID</span></label>
          <input id="feed-id" className="input-text" spellCheck={false} placeholder="0x..." value={feed} onChange={(e) => setFeed(e.target.value.trim())} />
          <div className="field-foot"><span>Only feeds approved on the oracle can back a market, and each feed backs one.</span></div>
        </div>
      </div>
      <AmountField label="Open interest limit" value={oiText} onChange={setOiText} decimals={18} unit="USD" error={oiHigh ? `This tier allows up to ${usd(tier.maxOiUsdWad)}` : null} />
      <AmountField label="Bond" value={bondText} onChange={setBondText} decimals={token.decimals} unit={token.symbol} error={bondLow ? `This tier needs at least ${amountText(view, c.collateral, tier.minBond, 2)}` : null} help="Used only if a shortfall reaches it. You can reclaim the rest after the market closes and empties." />
      <TxProgress steps={steps} />
      {problem ? <p className="notice" data-tone="warning" role="alert">{problem}</p> : null}
      <WalletGate>
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ready || busy} onClick={() => void go()}>{busy ? "Check your wallet" : "Create market"}</button>
      </WalletGate>
      <p className={styles.note}>Creating a market is public: your wallet, the feed and the bond are visible on chain. Trades in the market stay private.</p>
    </section>
  );
}

export function PrivateCreate() {
  const view = useView();
  if (!view) return <Offline title="Create a market" />;
  return (
    <div className={styles.page}>
      <PageHead title="Create a market" sub="Pick a risk tier and an approved price feed, then post a bond." />
      {view.create ? <Form view={view} /> : <StateBlock kind="unavailable" title="Market creation isn't available on this deployment" />}
    </div>
  );
}
