"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { formatFixed, parseDecimal, toDecimalInput } from "@rooq/sdk";
import { Dialog } from "@/components/feedback/dialog";
import { AmountField } from "@/components/funds/amount-field";
import { useSlippageBps } from "@/lib/preferences";
import { usePrivate, wallet } from "@/lib/private/client";
import {
  bandForDeposit, bandFromQuote, checkAgainstMark, maySuggest, midBandWad, midPriceBand, openHigh, openLow, readingFor, removalEstimate, toHumanPrice, typedBandOf, type MarkCheck, type MarkReading,
  type PriceBand, type WadBand,
} from "@/lib/private/lp-bounds";
import { PRIVATE_MARKET_BY_KEY, PRIVATE_POOL_BY_KEY } from "@/lib/private/markets";
import type { LpView, PoolView, PrivateView } from "@/lib/private/types";
import { balanceOf, ExpiryPicker, Offline, PageHead, PV, ServiceNotice, styles, SyncBadge, TokenPair, tokenOf, useView, withAccount } from "./kit";
import { fetchQuote, poolName } from "./spot";
import { LockRow } from "./trade";

const WAD = 10n ** 18n;

/** The pool's mid price from an indicative quote of `amountIn` token0, undone with the fee the chain charges. */
async function priceBand(pool: PoolView, amountIn: bigint, feeBps: bigint): Promise<PriceBand> {
  const q = await fetchQuote(pool.id, 0n, pool.token0, amountIn);
  const band = midPriceBand(amountIn, q.amountOut, feeBps, q.priceImpactBps);
  if (!band) throw new Error("The quote didn't give a usable price.");
  return band;
}

/** The perps market whose oracle prices this pool's token, from the build's own market map. */
function marketForPool(pool: PoolView): bigint | null {
  const key = [...PRIVATE_POOL_BY_KEY].find(([, id]) => id === pool.id)?.[0];
  return (key === undefined ? undefined : PRIVATE_MARKET_BY_KEY.get(key)) ?? null;
}

interface PoolPricing {
  /** The quote's mid-price band. Undefined until it loads, or for an unseeded pool. */
  readonly band: PriceBand | undefined;
  /** The oracle side of the check, from the chain. Null until it loads. */
  readonly reading: MarkReading | null;
  readonly oracleFailed: boolean;
  readonly quoteFailed: boolean;
}

/**
 * The pool's fee and the oracle price, both read from the chain, then a one-token quote undone with that fee, so the
 * band reads the same whatever amount is typed.
 */
function usePoolPricing(view: PrivateView, pool: PoolView | undefined): PoolPricing {
  const oracle = useQuery({
    queryKey: ["private-lp-oracle", pool?.id.toString() ?? "none"],
    queryFn: async () => {
      const read = await wallet.readPoolOracle(pool!.id, marketForPool(pool!));
      if (read.token0.toLowerCase() !== pool!.token0.toLowerCase() || read.token1.toLowerCase() !== pool!.token1.toLowerCase()) throw new Error("pool tokens differ on chain");
      return read;
    },
    enabled: pool !== undefined,
    staleTime: 15_000,
    retry: false,
  });
  const feeBps = oracle.data?.feeBps;
  const probe = pool ? 10n ** BigInt(tokenOf(view, pool.token0).decimals) : 0n;
  const quote = useQuery({
    queryKey: ["private-lp-price", pool?.id.toString() ?? "none", feeBps?.toString() ?? "none"],
    queryFn: () => priceBand(pool!, probe, feeBps!),
    enabled: pool !== undefined && pool.seeded && feeBps !== undefined,
    staleTime: 15_000,
    retry: false,
  });
  const reading = oracle.data && pool ? readingFor(oracle.data.feed, pool.token0, pool.token1, tokenOf(view, pool.token0).decimals, tokenOf(view, pool.token1).decimals) : null;
  return { band: quote.data, reading, oracleFailed: oracle.isError, quoteFailed: quote.isError };
}

const percent = (bps: number): string => `${bps / 100}%`;
const bpsText = (bps: bigint): string => `${(Number(bps) / 100).toFixed(2)}%`;

function priceText(view: PrivateView, pool: PoolView, poolWad: bigint): string {
  const human = toHumanPrice(poolWad, tokenOf(view, pool.token0).decimals, tokenOf(view, pool.token1).decimals);
  return formatFixed(human, 18, human >= WAD ? 4 : 8);
}

const unitText = (view: PrivateView, pool: PoolView): string => `${tokenOf(view, pool.token1).symbol} per ${tokenOf(view, pool.token0).symbol}`;

/** Where a band lets the request run, for a sentence that starts "Runs". An open edge has no limit on that side. */
function rangeText(view: PrivateView, pool: PoolView, band: WadBand): string {
  const unit = unitText(view, pool);
  if (openLow(band) && openHigh(band)) return "at any pool price, so nothing stops it if the price moves first";
  if (openLow(band)) return `only while the pool price is at most ${priceText(view, pool, band.hi)} ${unit}`;
  if (openHigh(band)) return `only while the pool price is at least ${priceText(view, pool, band.lo)} ${unit}`;
  return `only while the pool price is between ${priceText(view, pool, band.lo)} and ${priceText(view, pool, band.hi)} ${unit}`;
}

function ProtectionNote({ bps }: { bps: number }) {
  return <>The range is the pool price widened by your slippage, {percent(bps)}, from <Link href="/app/settings">Settings</Link>.</>;
}

/** What the person typed into "Edit range", in pool units, or null while it isn't a usable band. An empty field is no limit. */
function typedBand(view: PrivateView, pool: PoolView, lo: string, hi: string): WadBand | null {
  const field = (text: string): bigint | null | "bad" => (text.trim() === "" ? null : parseDecimal(text, 18) ?? "bad");
  const [l, h] = [field(lo), field(hi)];
  if (l === "bad" || h === "bad") return null;
  return typedBandOf(l, h, tokenOf(view, pool.token0).decimals, tokenOf(view, pool.token1).decimals);
}

interface RangeState {
  readonly editing: boolean;
  readonly lo: string;
  readonly hi: string;
}

const CLOSED_RANGE: RangeState = { editing: false, lo: "", hi: "" };

/** The accepted price range in human units, with "Edit range" to type it instead. `typeIt` when Rooq won't suggest one. */
function RangeControl({ view, pool, band, range, onRange, typeIt }: { view: PrivateView; pool: PoolView; band: WadBand | null; range: RangeState; onRange: (r: RangeState) => void; typeIt: boolean }) {
  const unit = unitText(view, pool);
  const edit = () => onRange({ editing: true, lo: band && !openLow(band) ? priceText(view, pool, band.lo) : "", hi: band && !openHigh(band) ? priceText(view, pool, band.hi) : "" });
  return (
    <div className={styles.stack}>
      <p className={styles.note}>
        {band ? <>Runs {rangeText(view, pool, band)}.</> : range.editing ? "Enter a lowest and highest price. Leave one empty for no limit on that side." : typeIt ? "Enter the range yourself." : "Reading the pool price to set the range. "}
        {" "}
        {range.editing ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => onRange(CLOSED_RANGE)}>Use the pool price</button> : <button type="button" className="btn btn-sm btn-ghost" onClick={edit}>Edit range</button>}
      </p>
      {range.editing ? (
        <>
          <AmountField label="Lowest price" value={range.lo} onChange={(lo) => onRange({ ...range, lo })} decimals={18} unit={unit} />
          <AmountField label="Highest price" value={range.hi} onChange={(hi) => onRange({ ...range, hi })} decimals={18} unit={unit} />
        </>
      ) : null}
    </div>
  );
}

const NO_ORACLE_READ = "Rooq couldn't read the pool's fee and market price from the chain, so it won't suggest a range. Enter one yourself or try again shortly.";
const NO_POOL_PRICE = "No pool price right now, so Rooq can't set a range. Edit the range yourself or try again shortly.";

/** Rooq's read of the operator's price against the market price. Null when there's nothing to say. */
function markNotice(check: MarkCheck, firstDeposit: boolean): string | null {
  if (check.kind === "no_feed") return firstDeposit ? null : "This token has no market price feed to check the pool price against, so check the range yourself.";
  if (check.kind === "no_price") return "The market price is stale and Rooq has no earlier one to check against, so it won't suggest a range. Enter one yourself.";
  if (check.kind === "ok") return check.stale ? "The market price is stale, so Rooq checked this range against the last market price. Check it before you continue." : null;
  const off = bpsText(check.offBps);
  if (check.kind === "warn") {
    return firstDeposit
      ? `Your price is ${off} away from the market price. The first deposit sets the pool price, and traders can take the difference.`
      : `The pool price Rooq's operator quoted is ${off} away from the market price. Check the range before you continue.`;
  }
  const market = check.stale ? "the last market price, which is stale" : "the market price";
  return firstDeposit
    ? `Your price is ${off} away from ${market}. The first deposit sets the pool price, and traders can take the difference, so Rooq won't suggest a range. Enter one yourself.`
    : `The pool price Rooq's operator quoted is ${off} away from ${market}, so Rooq won't build a range from it. Edit the range yourself, or try again later.`;
}

function AddForm({ pool, view }: { pool: PoolView; view: PrivateView }) {
  const { status } = usePrivate();
  const slippageBps = useSlippageBps();
  const unlocked = status === "unlocked";
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(3_600n);
  const [range, setRange] = useState<RangeState>(CLOSED_RANGE);
  const pricing = usePoolPricing(view, pool);
  const [t0, t1] = [tokenOf(view, pool.token0), tokenOf(view, pool.token1)];
  const a0 = parseDecimal(a, t0.decimals);
  const a1 = parseDecimal(b, t1.decimals);
  const overBalance = unlocked && ((a0 !== null && a0 > balanceOf(view, pool.token0)) || (a1 !== null && a1 > balanceOf(view, pool.token1)));
  const amountsSet = a0 !== null && a0 > 0n && a1 !== null && a1 > 0n;
  const mid: WadBand | null = pool.seeded ? (pricing.band ? midBandWad(pricing.band) : null) : amountsSet ? { lo: (a1 * WAD) / a0, hi: (a1 * WAD) / a0 } : null;
  const check: MarkCheck | null = mid && pricing.reading ? checkAgainstMark(mid, pricing.reading, slippageBps) : null;
  const suggested: WadBand | null = !check || !maySuggest(check) ? null : pool.seeded ? (pricing.band ? bandFromQuote(pricing.band, slippageBps) : null) : amountsSet ? bandForDeposit(a0, a1, slippageBps) : null;
  const band = range.editing ? typedBand(view, pool, range.lo, range.hi) : suggested;
  const typeIt = pricing.oracleFailed || (check !== null && !maySuggest(check)) || (pool.seeded && pricing.quoteFailed);
  const warning = pricing.oracleFailed ? NO_ORACLE_READ : check ? markNotice(check, !pool.seeded) : pool.seeded && pricing.quoteFailed ? NO_POOL_PRICE : null;
  const fill = async () => {
    if (a0 === null || a0 <= 0n) return;
    try {
      const q = await fetchQuote(pool.id, 0n, pool.token0, a0);
      setB(toDecimalInput(q.amountOut, t1.decimals));
    } catch (error) {
      setNote(error instanceof Error ? error.message : "No quote right now.");
    }
  };
  const go = () => {
    if (!amountsSet || !band) return;
    void wallet.start({ t: "lpAdd", pool: pool.id, amount0: a0, amount1: a1, priceLo: band.lo, priceHi: band.hi, expiry }, `Add liquidity to ${poolName(view, pool)}`, "/app/liquidity").then(() => {
      setNote("Started. Both private locks go out together, then the pool takes them. Any excess comes back to you.");
      setA("");
      setB("");
      setRange(CLOSED_RANGE);
    });
  };
  return (
    <section className={`${styles.card} ${styles.lpCard}`} aria-label={`Add to ${poolName(view, pool)}`}>
      <div className={styles.cardHead}>
        <span className={styles.row}><TokenPair view={view} token0={pool.token0} token1={pool.token1} /><h2 className={styles.cardTitle}>{poolName(view, pool)}</h2></span>
        <span className={styles.badge} data-tone={pool.seeded ? "ok" : "warn"}>{pool.seeded ? `${Number(pool.feeBps) / 100}% fee` : "Needs a first deposit"}</span>
      </div>
      <AmountField label={t0.symbol} value={a} onChange={setA} decimals={t0.decimals} unit={t0.symbol} balanceLabel={unlocked ? "Private balance" : undefined} balance={balanceOf(view, pool.token0)} />
      <AmountField label={t1.symbol} value={b} onChange={setB} decimals={t1.decimals} unit={t1.symbol} balanceLabel={unlocked ? "Private balance" : undefined} balance={balanceOf(view, pool.token1)} />
      <div className={styles.row}>
        {pool.seeded ? <button type="button" className="btn btn-sm" onClick={() => void fill()}>Match pool ratio</button> : null}
        <ExpiryPicker value={expiry} onChange={setExpiry} />
      </div>
      {pool.seeded || amountsSet || range.editing ? <RangeControl view={view} pool={pool} band={band} range={range} onRange={setRange} typeIt={typeIt} /> : null}
      <p className={styles.note}>
        {pool.seeded ? "Reserves are private, so this uses a rounded price. The pool takes its exact ratio and refunds the rest. " : "You set the first price for this pool. If someone else seeds this pool first at a price outside this range, your add won't run and the locks come back at expiry. "}
        <ProtectionNote bps={slippageBps} /> If the pool price leaves the range before the add runs, it doesn&apos;t run and the locks come back at expiry.
      </p>
      {warning ? <p className="notice" data-tone="warning" role="status">{warning}</p> : null}
      {overBalance ? <p className="notice" role="status">This is more than your private balance.</p> : note ? <p className="notice" role="status">{note}</p> : null}
      <button type="button" className={`btn btn-primary btn-block ${styles.lpSubmit}`} disabled={!amountsSet || overBalance || band === null} onClick={() => withAccount(go)}>Add liquidity</button>
    </section>
  );
}

function PositionRow({ lp, view, onRemove }: { lp: LpView; view: PrivateView; onRemove: () => void }) {
  const pool = view.pools.find((p) => p.id === lp.pool);
  return (
    <div className={styles.rowLine} data-testid="lp-row" data-status={lp.status}>
      <span className={styles.row}>{pool ? <TokenPair view={view} token0={pool.token0} token1={pool.token1} /> : null}{pool ? poolName(view, pool) : `Pool ${lp.pool}`}</span>
      <span className={styles.row}>
        <PV>{`${formatFixed(lp.shares, 18, 6)} shares`}</PV>
        {lp.status === "idle" ? <button type="button" className="btn btn-sm" onClick={onRemove}>Remove</button> : null}
        {lp.status === "removing" ? <span className={styles.badge}>Removal requested</span> : null}
        {lp.status === "removing" && pool ? <PV>{`Runs ${rangeText(view, pool, { lo: lp.priceLo, hi: lp.priceHi })}`}</PV> : null}
        {lp.status === "request_expired" ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void wallet.start({ t: "lpRecover", claim: lp.id }, "Return liquidity to idle", "/app/liquidity")}>Return to idle</button>
        ) : null}
      </span>
    </div>
  );
}

function RemoveDialog({ lp, view, onClose }: { lp: LpView | null; view: PrivateView; onClose: () => void }) {
  const [range, setRange] = useState<RangeState>(CLOSED_RANGE);
  const [expiry, setExpiry] = useState(3_600n);
  const slippageBps = useSlippageBps();
  const pool = lp ? view.pools.find((p) => p.id === lp.pool) : undefined;
  const pricing = usePoolPricing(view, pool);
  if (!lp || !pool) return null;
  const [t0, t1] = [tokenOf(view, pool.token0), tokenOf(view, pool.token1)];
  const check = pricing.band && pricing.reading ? checkAgainstMark(midBandWad(pricing.band), pricing.reading, slippageBps) : null;
  const suggested = pricing.band && check && maySuggest(check) ? bandFromQuote(pricing.band, slippageBps) : null;
  const band = range.editing ? typedBand(view, pool, range.lo, range.hi) : suggested;
  const open = band !== null && (openLow(band) || openHigh(band));
  const estimate = band && !open ? removalEstimate(lp.shares, band) : null;
  const typeIt = pricing.oracleFailed || pricing.quoteFailed || (check !== null && !maySuggest(check));
  const warning = pricing.oracleFailed ? NO_ORACLE_READ : check ? markNotice(check, false) : pricing.quoteFailed ? NO_POOL_PRICE : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Remove from ${poolName(view, pool)}`} description="A private request the operator fills. If it's ignored past expiry, your shares return to idle." width={460}>
      <div className={styles.stack}>
        <RangeControl view={view} pool={pool} band={band} range={range} onRange={setRange} typeIt={typeIt} />
        {open ? <p className={styles.note}>With no limit on one side, Rooq can&apos;t say the least you&apos;d get back.</p> : null}
        {estimate ? <p className={styles.note}>You get at least about <PV>{`${formatFixed(estimate.out0, t0.decimals, 6)} ${t0.symbol}`}</PV> and <PV>{`${formatFixed(estimate.out1, t1.decimals, 6)} ${t1.symbol}`}</PV> at the edge of this range.</p> : null}
        <p className={styles.note}><ProtectionNote bps={slippageBps} /> The price comes from Rooq&apos;s operator, so check it against the market if the amount matters.</p>
        {warning ? <p className="notice" data-tone="warning" role="status">{warning}</p> : null}
        <ExpiryPicker value={expiry} onChange={setExpiry} />
        <button type="button" className="btn btn-primary btn-block" disabled={band === null} onClick={() => { if (!band) return; void wallet.start({ t: "lpRequest", claim: lp.id, priceLo: band.lo, priceHi: band.hi, expiry }, `Remove liquidity from ${poolName(view, pool)}`, "/app/liquidity"); onClose(); }}>Request removal</button>
      </div>
    </Dialog>
  );
}

function Body() {
  const view = useView();
  const [removing, setRemoving] = useState<LpView | null>(null);
  if (!view) return <Offline title="Private liquidity" />;
  const locks = view.locks.filter((l) => l.role === "lp" && (l.status === "live" || l.status === "queued" || l.status === "expired"));
  return (
    <div className={styles.page}>
      <PageHead title="Private liquidity" sub="Deposit into a pool privately. Pool reserves and your share stay hidden." actions={<SyncBadge />} />
      <ServiceNotice />
      <div className={styles.split}>
        <div className={styles.grid2}>
          {view.pools.map((p) => <AddForm key={p.id.toString()} pool={p} view={view} />)}
        </div>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Your positions</h2>
          {!view.unlocked ? <p className={styles.note}>Your positions are private. Open your account to see them.</p> : view.lp.length === 0 && locks.length === 0 ? <p className={styles.note}>No liquidity yet.</p> : null}
          {view.lp.map((lp) => <PositionRow key={lp.id} lp={lp} view={view} onRemove={() => setRemoving(lp)} />)}
          {locks.map((l) => <LockRow key={l.id} l={l} view={view} />)}
        </section>
      </div>
      <RemoveDialog key={removing?.id ?? "none"} lp={removing} view={view} onClose={() => setRemoving(null)} />
    </div>
  );
}

export function PrivateLiquidity() {
  return <Body />;
}

