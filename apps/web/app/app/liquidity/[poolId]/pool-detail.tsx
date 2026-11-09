"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { formatBps, formatFixed, mockERC20Abi, parseDecimal, spotPoolAbi } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { findMarket, useAccountSnapshot, useMarketSnapshots, type MarketSnapshot } from "@/lib/chain-data";
import { shareBps, usePoolExtras, type PoolExtras } from "@/lib/pools";
import { useSlippageBps } from "@/lib/preferences";
import { deadlineBase, useTxRunner, type WriteRequest } from "@/lib/tx";
import { useChainNow } from "@/lib/use-now";
import { AmountField } from "@/components/funds/amount-field";
import { TxProgress } from "@/components/feedback/tx-progress";
import { WalletGate } from "@/components/wallet";
import { ActionButton, Address, AssetEmblem, Segmented, Sensitive, SpotStatusPill, StateBlock, TestTag } from "@/components/primitives";
import styles from "../liquidity.module.css";

type Tab = "add" | "remove";
const PERCENTS = [25, 50, 75, 100] as const;

/** LQ02. Add or remove liquidity on one Rooq pool with exact amounts and slippage-bounded minimums. */
export function PoolDetail({ poolKey }: { poolKey: string }) {
  const { data: markets, isLoading, isError } = useMarketSnapshots();
  const { data: extras } = usePoolExtras();
  const m = findMarket(markets, poolKey);
  const x = m ? extras?.[m.marketId] : undefined;
  const [tab, setTab] = useState<Tab>("add");

  if (isLoading) return <StateBlock kind="loading" title="Reading the pool from the chain" />;
  if (isError) {
    return (
      <div className={styles.page}>
        <StateBlock kind="unavailable" title="This pool can't be read right now" body="Reserves and your claim are not shown until they can be verified." />
      </div>
    );
  }
  if (!m) {
    return (
      <div className={styles.page}>
        <StateBlock kind="empty" title="No Rooq pool matches this address or market" actions={<Link className="btn btn-sm" href="/app/liquidity">{copy.liquidity.title}</Link>} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
          <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={40} label={m.base.symbol} />
          <h1 className="t-section">{`${m.base.symbol} / ${m.quote.symbol}`}</h1>
          {m.base.isTestFixture ? <TestTag>Test fixture</TestTag> : null}
          {x?.paused ? <SpotStatusPill status="PAUSED" funded /> : <SpotStatusPill status={m.spotStatus} funded={m.reserveBase > 0n} />}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {copy.liquidity.warning}
        </p>
      </header>
      <div className={styles.detail}>
        <div className={styles.panelSection}>
          <YourClaim m={m} x={x} />
          <PoolFacts m={m} x={x} />
        </div>
        <section aria-label="Manage liquidity">
          <div className="panel-head">
            <Segmented
              label="Add or remove"
              value={tab}
              onChange={setTab}
              options={[
                { value: "add", label: copy.liquidity.add },
                { value: "remove", label: copy.liquidity.remove },
              ]}
            />
          </div>
          <div className={styles.panelBody}>{tab === "add" ? <AddLiquidity m={m} x={x} /> : <RemoveLiquidity m={m} x={x} />}</div>
        </section>
      </div>
    </div>
  );
}

/** The owner's claim leads: what their shares redeem for now, at the pool's current ratio. */
function YourClaim({ m, x }: { m: MarketSnapshot; x: PoolExtras | undefined }) {
  const { address } = useAccount();
  const { data: acct } = useAccountSnapshot(address);
  if (!address) return <StateBlock kind="locked" title="Connect a wallet to see your claim on this pool" />;
  const shares = acct?.lpShares[m.marketId] ?? null;
  if (shares === null || !x) return <StateBlock kind="loading" title="Reading your claim" />;
  if (shares === 0n) return <StateBlock kind="empty" title="You don't provide liquidity to this pool" />;
  const baseOut = x.lpSupply > 0n ? (shares * m.reserveBase) / x.lpSupply : 0n;
  const quoteOut = x.lpSupply > 0n ? (shares * m.reserveQuote) / x.lpSupply : 0n;
  const baseValue = m.poolPrice === null ? 0n : (baseOut * m.poolPrice) / 10n ** 18n / 10n ** BigInt(18 - m.quote.decimals);
  const total = baseValue + quoteOut;
  return (
    <section className={styles.claim} aria-label="Your claim">
      <span className="t-label muted">Your claim, at the current pool ratio</span>
      <p className={styles.claimValue}>
        <Sensitive>{`${formatFixed(total, m.quote.decimals, 2)} ${m.quote.symbol}`}</Sensitive>
      </p>
      {total > 0n ? (
        <div className={styles.composition} aria-hidden>
          <span style={{ flexGrow: Number((baseValue * 1000n) / total) }} />
          <span style={{ flexGrow: Number((quoteOut * 1000n) / total) }} />
        </div>
      ) : null}
      <div className={styles.compositionKey}>
        <span><Sensitive>{`${formatFixed(baseOut, m.base.decimals, 4)} ${m.base.symbol}`}</Sensitive></span>
        <span><Sensitive>{`${formatFixed(quoteOut, m.quote.decimals, 2)} ${m.quote.symbol}`}</Sensitive></span>
      </div>
      <p className="t-small faint" style={{ margin: 0 }}>Estimate. Pool prices move, and fees stay in the reserves. Private LP claims arrive with private V1.</p>
    </section>
  );
}

function PoolFacts({ m, x }: { m: MarketSnapshot; x: PoolExtras | undefined }) {
  const { address } = useAccount();
  const { data: acct } = useAccountSnapshot(address);
  const yours = acct?.lpShares[m.marketId] ?? null;
  const baseIs0 = x ? x.token0.toLowerCase() === m.base.address.toLowerCase() : true;
  const share = x && yours !== null ? shareBps(yours, x.lpSupply) : null;
  return (
    <section aria-label="Pool facts">
      <div className="panel-head">
        <h2 className="t-label" style={{ margin: 0 }}>
          {copy.liquidity.reserves}
        </h2>
        <span className={styles.formula}>x × y = k</span>
      </div>
      <div className={styles.panelBody}>
        <dl className="facts">
          <div>
            <dt>{m.base.symbol}</dt>
            <dd>{formatFixed(m.reserveBase, m.base.decimals, 4)}</dd>
          </div>
          <div>
            <dt>{m.quote.symbol}</dt>
            <dd>{formatFixed(m.reserveQuote, m.quote.decimals, 2)}</dd>
          </div>
          <div>
            <dt>Pool price</dt>
            <dd>{m.poolPrice === null ? "—" : `${formatFixed(m.poolPrice, 18, 2)} ${m.quote.symbol}`}</dd>
          </div>
          <div>
            <dt>Fee tier</dt>
            <dd>{formatBps(m.poolFeeBps)}</dd>
          </div>
          <div>
            <dt>{copy.liquidity.fees}</dt>
            <dd>
              {x ? `${formatFixed(baseIs0 ? x.feesAccrued0 : x.feesAccrued1, m.base.decimals, 4)} ${m.base.symbol}` : "—"}
              <span className="sub">{x ? `${formatFixed(baseIs0 ? x.feesAccrued1 : x.feesAccrued0, m.quote.decimals, 2)} ${m.quote.symbol}, all LPs together` : ""}</span>
            </dd>
          </div>
          <div>
            <dt>LP shares outstanding</dt>
            <dd>{x ? formatFixed(x.lpSupply, 18, 6) : "—"}</dd>
          </div>
          <div>
            <dt>{copy.liquidity.share}</dt>
            <dd>{!address ? "—" : yours === null || share === null ? "—" : yours === 0n ? "None" : formatBps(share)}</dd>
          </div>
        </dl>
        <p className="t-small muted" style={{ margin: 0 }}>
          Swap fees stay in the reserves, so each LP share redeems for more of both tokens as fees accrue. Rooq pool reserves are never used as perp margin.
        </p>
        <Address value={m.pool} />
      </div>
    </section>
  );
}

function AddLiquidity({ m, x }: { m: MarketSnapshot; x: PoolExtras | undefined }) {
  const client = usePublicClient();
  const { address } = useAccount();
  const { data: acct } = useAccountSnapshot(address);
  const slippage = BigInt(useSlippageBps());
  const chainNow = useChainNow();
  const tx = useTxRunner();
  const [baseText, setBaseText] = useState("");
  const [quoteText, setQuoteText] = useState("");
  const funded = m.reserveBase > 0n && m.reserveQuote > 0n;
  const base = parseDecimal(baseText, m.base.decimals);
  const quote = parseDecimal(quoteText, m.quote.decimals);
  const baseBal = acct ? (acct.baseBalances[m.marketId] ?? 0n) : null;
  const quoteBal = acct?.walletCollateral ?? null;
  const supply = x?.lpSupply ?? 0n;
  const shares = funded && base && quote && supply > 0n ? minBig((base * supply) / m.reserveBase, (quote * supply) / m.reserveQuote) : null;
  const shortBase = base !== null && baseBal !== null && base > baseBal;
  const shortQuote = quote !== null && quoteBal !== null && quote > quoteBal;
  const ok = Boolean(funded && base && quote && base > 0n && quote > 0n && !shortBase && !shortQuote && shares && shares > 0n && !x?.paused);

  const submit = async () => {
    if (!client || !address || !base || !quote || chainNow === null || !x) return;
    const [baseAllowance, quoteAllowance] = await Promise.all([
      client.readContract({ address: m.base.address, abi: mockERC20Abi, functionName: "allowance", args: [address, m.pool] }),
      client.readContract({ address: m.quote.address, abi: mockERC20Abi, functionName: "allowance", args: [address, m.pool] }),
    ]);
    const baseIs0 = x.token0.toLowerCase() === m.base.address.toLowerCase();
    const minBase = (base * (10_000n - slippage)) / 10_000n;
    const minQuote = (quote * (10_000n - slippage)) / 10_000n;
    const requests: WriteRequest[] = [
      ...(baseAllowance < base ? [{ label: `Approve ${formatFixed(base, m.base.decimals, 4)} ${m.base.symbol}`, address: m.base.address, abi: mockERC20Abi, functionName: "approve", args: [m.pool, base] }] : []),
      ...(quoteAllowance < quote ? [{ label: `Approve ${formatFixed(quote, m.quote.decimals, 2)} ${m.quote.symbol}`, address: m.quote.address, abi: mockERC20Abi, functionName: "approve", args: [m.pool, quote] }] : []),
      {
        label: copy.liquidity.add,
        address: m.pool,
        abi: spotPoolAbi,
        functionName: "addLiquidity",
        args: baseIs0 ? [base, quote, minBase, minQuote, address, BigInt(deadlineBase(chainNow) + 300)] : [quote, base, minQuote, minBase, address, BigInt(deadlineBase(chainNow) + 300)],
      },
    ];
    const done = await tx.run(requests, { kind: "liquidity", title: `${copy.liquidity.add}: ${m.base.symbol} / ${m.quote.symbol}` });
    if (done) {
      setBaseText("");
      setQuoteText("");
    }
  };

  return (
    <>
      {!funded ? <p className="notice">{copy.spot.emptyPool} Create the market with seed liquidity from Create market.</p> : null}
      <AmountField
        label={m.base.symbol}
        value={baseText}
        onChange={(v) => {
          setBaseText(v);
          const parsed = parseDecimal(v, m.base.decimals);
          setQuoteText(parsed !== null && funded ? formatFixed(ceilDiv(parsed * m.reserveQuote, m.reserveBase), m.quote.decimals, m.quote.decimals, { group: false }) : "");
        }}
        decimals={m.base.decimals}
        unit={m.base.symbol}
        balanceLabel="Wallet"
        balance={baseBal}
        error={shortBase ? copy.errors.insufficientBalance : null}
      />
      <AmountField
        label={m.quote.symbol}
        value={quoteText}
        onChange={(v) => {
          setQuoteText(v);
          const parsed = parseDecimal(v, m.quote.decimals);
          setBaseText(parsed !== null && funded ? formatFixed((parsed * m.reserveBase) / m.reserveQuote, m.base.decimals, m.base.decimals, { group: false }) : "");
        }}
        decimals={m.quote.decimals}
        unit={m.quote.symbol}
        balanceLabel="Wallet"
        balance={quoteBal}
        error={shortQuote ? copy.errors.insufficientBalance : null}
      />
      <dl className="facts">
        <div>
          <dt>LP shares you receive</dt>
          <dd>{shares === null ? "—" : formatFixed(shares, 18, 6)}</dd>
        </div>
        <div>
          <dt>Pool share after</dt>
          <dd>{shares === null ? "—" : formatBps(shareBps((acct?.lpShares[m.marketId] ?? 0n) + shares, supply + shares) ?? 0n)}</dd>
        </div>
        <div>
          <dt>{copy.spot.slippage}</dt>
          <dd>{formatBps(slippage)}</dd>
        </div>
      </dl>
      <p className="t-small muted" style={{ margin: 0 }}>
        Amounts follow the pool&apos;s current ratio. The deposit reverts if the pool would use less than your minimum of either token.
      </p>
      <WalletGate>
        <ActionButton disabled={!ok} state={tx.busy ? "working" : "idle"} onClick={() => void submit()}>
          {tx.busy ? copy.activity.pending : copy.liquidity.add}
        </ActionButton>
      </WalletGate>
      <TxProgress steps={tx.steps} />
    </>
  );
}

function RemoveLiquidity({ m, x }: { m: MarketSnapshot; x: PoolExtras | undefined }) {
  const { address } = useAccount();
  const { data: acct } = useAccountSnapshot(address);
  const slippage = BigInt(useSlippageBps());
  const chainNow = useChainNow();
  const tx = useTxRunner();
  const [pct, setPct] = useState<number>(50);
  const yours = acct?.lpShares[m.marketId] ?? 0n;
  const supply = x?.lpSupply ?? 0n;
  const shares = (yours * BigInt(pct)) / 100n;
  const outBase = supply > 0n ? (shares * m.reserveBase) / supply : 0n;
  const outQuote = supply > 0n ? (shares * m.reserveQuote) / supply : 0n;
  const minBase = (outBase * (10_000n - slippage)) / 10_000n;
  const minQuote = (outQuote * (10_000n - slippage)) / 10_000n;

  const submit = async () => {
    if (!address || chainNow === null || !x || shares === 0n) return;
    const baseIs0 = x.token0.toLowerCase() === m.base.address.toLowerCase();
    const done = await tx.run([
      {
        label: `${copy.liquidity.remove} (${pct}%)`,
        address: m.pool,
        abi: spotPoolAbi,
        functionName: "removeLiquidity",
        args: baseIs0 ? [shares, minBase, minQuote, address, BigInt(deadlineBase(chainNow) + 300)] : [shares, minQuote, minBase, address, BigInt(deadlineBase(chainNow) + 300)],
      },
    ], { kind: "liquidity" });
    if (done) setPct(50);
  };

  return (
    <>
      <div className="chips" role="group" aria-label="Share of your position to remove">
        {PERCENTS.map((p) => (
          <button key={p} type="button" className="chip" aria-pressed={pct === p} onClick={() => setPct(p)}>
            {`${p}%`}
          </button>
        ))}
      </div>
      <dl className="facts">
        <div>
          <dt>LP shares to burn</dt>
          <dd>{address ? formatFixed(shares, 18, 6) : "—"}</dd>
        </div>
        <div>
          <dt>{`You receive ${m.base.symbol}`}</dt>
          <dd>
            {address ? formatFixed(outBase, m.base.decimals, 4) : "—"}
            <span className="sub">{address ? `at least ${formatFixed(minBase, m.base.decimals, 4)}` : ""}</span>
          </dd>
        </div>
        <div>
          <dt>{`You receive ${m.quote.symbol}`}</dt>
          <dd>
            {address ? formatFixed(outQuote, m.quote.decimals, 2) : "—"}
            <span className="sub">{address ? `at least ${formatFixed(minQuote, m.quote.decimals, 2)}` : ""}</span>
          </dd>
        </div>
      </dl>
      <p className="t-small muted" style={{ margin: 0 }}>
        Withdrawals work even while a pool is paused. You get both tokens in the pool&apos;s current ratio, which may differ from what you deposited.
      </p>
      <WalletGate>
        <ActionButton variant="danger" disabled={shares === 0n} state={tx.busy ? "working" : "idle"} onClick={() => void submit()}>
          {tx.busy ? copy.activity.pending : yours === 0n ? "No LP shares to remove" : copy.liquidity.remove}
        </ActionButton>
      </WalletGate>
      <TxProgress steps={tx.steps} />
    </>
  );
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return b === 0n ? 0n : (a + b - 1n) / b;
}
