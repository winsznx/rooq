"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { AnimatePresence, motion } from "motion/react";
import {
  absBig,
  estimatedLiquidationPrice,
  fee as feeFor,
  formatCountdown,
  formatFixed,
  formatLeverageTenths,
  marginRequirement,
  parseDecimal,
  pnlFloor,
  scaleFor,
  shortAddress,
} from "@rooq/sdk";
import { copy } from "@rooq/ui";
import type { AccountSnapshot, MarketSnapshot } from "@/lib/chain-data";
import { requestPerpQuote, QuoteRefused, type SignedQuote } from "@/lib/quotes";
import { useChainNow } from "@/lib/use-now";
import { collateral, fundingPayer, fundingPerHour, percentDistance, price } from "@/lib/display";
import { WalletGate, useWalletState } from "../wallet";
import { ConsentDialog, hasConsent } from "../funds/consent-dialog";
import { DepositDialog } from "../funds/funds-dialogs";
import { ActionButton, Hint, PriceKindTag } from "../primitives";
import { ArrowDown, ArrowUp } from "../icons";
import { FADE } from "@/lib/motion";
import { ReviewTradeDialog } from "./review-dialog";
import styles from "./trade.module.css";

type Side = "long" | "short";
type QuoteState =
  | { kind: "none" }
  | { kind: "requesting" }
  | { kind: "live"; q: SignedQuote; key: string }
  | { kind: "refused"; reasonCode: string; message: string; availableBase: bigint | null }
  | { kind: "error"; message: string };

const WAD = 10n ** 18n;

function presetsFor(maxTenths: number): number[] {
  if (maxTenths <= 20) return [10, 15, 20].filter((v) => v <= maxTenths);
  if (maxTenths <= 30) return [10, 20, 30];
  if (maxTenths <= 50) return [10, 20, 30, 50];
  return [10, 20, 50, 100].filter((v) => v <= maxTenths);
}

/** Leverage typed as text ("1.5") to tenths (15). Returns null when not a valid number. */
function parseLeverage(text: string): number | null {
  const v = parseDecimal(text, 1);
  return v === null ? null : Number(v);
}

export function PerpsTicket({ m, acct }: { m: MarketSnapshot; acct: AccountSnapshot | null | undefined }) {
  const { address } = useAccount();
  const { isConnected, wrongChain } = useWalletState();
  const chainNow = useChainNow();
  const [side, setSide] = useState<Side>("long");
  const [sizeText, setSizeText] = useState("");
  const [levText, setLevText] = useState("1.0");
  const [quote, setQuote] = useState<QuoteState>({ kind: "none" });
  const [consentOpen, setConsentOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [review, setReview] = useState<{
    signed: bigint;
    quote: SignedQuote;
    margin: bigint;
    fee: bigint;
    liq: bigint | null;
    leverageTenths: number;
    side: Side;
  } | null>(null);
  const [levNote, setLevNote] = useState<string | null>(null);

  const risk = m.risk;
  const maxTenths = risk?.maxLeverageTenths ?? 10;
  const scale = scaleFor(m.quote.decimals);
  const notional = parseDecimal(sizeText, m.quote.decimals);
  const levTenths = parseLeverage(levText);
  const levValid = levTenths !== null && levTenths >= 10 && levTenths <= maxTenths;
  const mark = m.mark;
  const existing = acct?.positions.find((p) => p.marketId === m.marketId) ?? null;
  const conflicting = existing !== null && (existing.size > 0n) !== (side === "long");

  const sizeBase = notional !== null && mark !== null && mark > 0n ? (notional * scale * WAD) / mark : null;
  const signed = sizeBase === null ? null : side === "long" ? sizeBase : -sizeBase;
  const inputsKey = `${side}:${notional?.toString()}:${levTenths}:${m.marketId}`;
  const liveQuote = quote.kind === "live" && quote.key === inputsKey ? quote.q : null;
  const quoteVoided = quote.kind === "live" && quote.key !== inputsKey;
  const secondsLeft = liveQuote && chainNow !== null ? Number(liveQuote.quote.deadline) - chainNow : null;
  const expired = secondsLeft !== null && secondsLeft <= 0;
  const execPrice = liveQuote?.quote.price ?? null;
  // The maker signed a fixed size. The mark can move after quoting, which changes `signed`; the fill
  // and every number shown must use the size that was actually signed.
  const tradeSize = liveQuote?.quote.size ?? signed;

  const numbers = useMemo(() => {
    if (!risk || tradeSize === null || mark === null || notional === null || !levValid || levTenths === null) return null;
    const byLeverage = (notional * 10n + BigInt(levTenths) - 1n) / BigInt(levTenths);
    const entry = execPrice ?? mark;
    const totalSize = (existing?.size ?? 0n) + tradeSize;
    const im = marginRequirement(absBig(totalSize), mark, risk.imrWad, scale);
    const spread = pnlFloor(tradeSize, entry, mark, scale);
    // Onchain the taker needs equity >= initial margin on the whole position at the mark after the fill.
    // An existing position brings its current equity; the quote's spread counts against equity at once.
    // A 0.25% buffer absorbs a relay update between quote and fill.
    const equityBefore = existing?.takerEquity ?? 0n;
    const shortBy = im - spread - equityBefore;
    const required = shortBy > 0n ? shortBy : 0n;
    const buffered = required + required / 400n + 1n;
    const margin = byLeverage > buffered ? byLeverage : buffered;
    const fee = feeFor(absBig(tradeSize), entry, BigInt(risk.takerFeeBps), scale);
    const totalEntry = existing ? (absBig(existing.size) * existing.entryPrice + absBig(tradeSize) * entry) / absBig(totalSize) : entry;
    const totalMargin = (existing?.takerMargin ?? 0n) + margin;
    const liq = estimatedLiquidationPrice({ size: totalSize, entryPrice: totalEntry, marginTokens: totalMargin, mmrWad: risk.mmrWad, scale });
    return { margin, fee, liq, im, spreadCost: spread < 0n ? -spread : 0n, effectiveLeverageTenths: margin === 0n ? 0n : (notional * 10n) / margin };
  }, [risk, tradeSize, mark, notional, levValid, levTenths, execPrice, scale, existing]);

  const free = acct?.vaultFree ?? null;
  const shortfall = numbers && free !== null && free < numbers.margin + numbers.fee;
  const statusBlock =
    m.perpStatus === "CLOSE_ONLY" || (m.perpStatus === "ACTIVE" && !m.markFresh)
      ? m.markFresh
        ? copy.errors.paused
        : copy.errors.oracleStale
      : m.perpStatus !== "ACTIVE"
        ? m.perpStatus === "REGISTERED"
          ? copy.preflight.capacityMissing
          : copy.errors.paused
        : null;

  const getQuote = async () => {
    if (!address || signed === null || signed === 0n) return;
    if (!hasConsent(address)) {
      setConsentOpen(true);
      return;
    }
    setQuote({ kind: "requesting" });
    try {
      const q = await requestPerpQuote({ marketId: m.marketId, taker: address, size: signed });
      setQuote({ kind: "live", q, key: inputsKey });
    } catch (error) {
      if (error instanceof QuoteRefused) {
        const details = error.details as { availableBase?: string } | undefined;
        setQuote({
          kind: "refused",
          reasonCode: error.reasonCode,
          message: error.reasonCode === "MAKER_CAPACITY_EXHAUSTED" ? copy.perps.noLiquidity : error.message,
          availableBase: details?.availableBase ? BigInt(details.availableBase) : null,
        });
      } else {
        setQuote({ kind: "error", message: "The quote service did not respond. Your balances have not changed." });
      }
    }
  };

  const onLevBlur = () => {
    const t = parseLeverage(levText);
    if (t === null || t < 10) {
      setLevText("1.0");
      setLevNote("Leverage starts at 1.0x.");
    } else if (t > maxTenths) {
      setLevText(formatLeverageTenths(maxTenths).replace("x", ""));
      setLevNote(`Max for this market is ${formatLeverageTenths(maxTenths)}.`);
    } else {
      setLevText(formatFixed(BigInt(t), 1, 1));
      setLevNote(null);
    }
  };

  let cta: { label: string; disabled: boolean; action?: () => void } = { label: copy.perps.getQuote, disabled: true };
  if (statusBlock) cta = { label: statusBlock, disabled: true };
  else if (conflicting) cta = { label: `Close your ${existing && existing.size > 0n ? "long" : "short"} first`, disabled: true };
  else if (notional === null || notional === 0n) cta = { label: "Enter a position size", disabled: true };
  else if (!levValid) cta = { label: `Leverage must be 1.0x to ${formatLeverageTenths(maxTenths)}`, disabled: true };
  else if (shortfall) cta = { label: `${copy.errors.insufficientMargin.replace(".", "")}. ${copy.portfolio.deposit} ${m.quote.symbol}`, disabled: false, action: () => setDepositOpen(true) };
  else if (quote.kind === "requesting") cta = { label: "Requesting quote", disabled: true };
  else if (liveQuote && !expired && numbers)
    cta = {
      label: `${side === "long" ? "Review long" : "Review short"} ${formatFixed(absBig(liveQuote.quote.size), 18, 4)} ${m.base.symbol}`,
      disabled: false,
      action: () => setReview({ signed: liveQuote.quote.size, quote: liveQuote, margin: numbers.margin, fee: numbers.fee, liq: numbers.liq, leverageTenths: levTenths ?? 10, side }),
    };
  else cta = { label: copy.perps.getQuote, disabled: false, action: () => void getQuote() };

  return (
    <div className={styles.ticket}>
      <div className={styles.ticketContext}>
        <p className={styles.modeNote}>Perpetuals use collateral. You won&apos;t receive the token.</p>
        <span className={styles.modeMeta}>{`Isolated, max ${formatLeverageTenths(maxTenths)}. Market order via maker quote.`}</span>
      </div>

      <div className="side" role="group" aria-label="Direction">
        {(["long", "short"] as const).map((s) => (
          <button
            key={s}
            type="button"
            data-side={s}
            aria-pressed={side === s}
            onClick={() => {
              setSide(s);
              setQuote({ kind: "none" });
            }}
          >
            {s === "long" ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
            {s === "long" ? copy.perps.long : copy.perps.short}
          </button>
        ))}
      </div>

      <div className="field">
        <label className="field-label" htmlFor="perp-size">
          <span>{copy.perps.positionSize}</span>
        </label>
        <div className="input-wrap" data-size="lg">
          <input
            id="perp-size"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={sizeText}
            onChange={(e) => setSizeText(e.target.value.replace(/[^\d.,]/g, ""))}
          />
          <span className="unit">{m.quote.symbol}</span>
        </div>
        <div className="field-foot">
          <span />
          <span className="num">{sizeBase === null ? "—" : `${formatFixed(sizeBase, 18, 4)} ${m.base.symbol}`}</span>
        </div>
      </div>

      <div className="field">
        <div className="field-label">
          <label htmlFor="perp-lev">{copy.perps.leverage}</label>
          <span className="faint">{copy.perps.maxLev}: {formatLeverageTenths(maxTenths)}</span>
        </div>
        <div className={styles.leverageRow}>
          <div className={`input-wrap ${styles.leverageInput}`}>
            <input
              id="perp-lev"
              inputMode="decimal"
              autoComplete="off"
              value={levText}
              onChange={(e) => {
                setLevText(e.target.value.replace(/[^\d.]/g, ""));
                setLevNote(null);
              }}
              onBlur={onLevBlur}
              aria-describedby={levNote ? "perp-lev-note" : undefined}
            />
            <span className="unit" style={{ minWidth: 0 }}>x</span>
          </div>
          <div className="chips" role="group" aria-label="Leverage presets">
            {presetsFor(maxTenths).map((t) => (
              <button
                key={t}
                type="button"
                className="chip"
                aria-pressed={levTenths === t}
                onClick={() => {
                  setLevText(formatFixed(BigInt(t), 1, 1));
                  setLevNote(null);
                }}
              >
                {formatLeverageTenths(t)}
              </button>
            ))}
          </div>
        </div>
        {levNote ? (
          <p id="perp-lev-note" className="field-error" style={{ margin: 0 }} role="status">
            {levNote}
          </p>
        ) : null}
      </div>

      <section className={styles.priceStack} aria-label="Prices for this order">
        <AnimatePresence mode="wait" initial={false}>
          {liveQuote ? (
            <motion.div key="quote" className={styles.firm} role="group" aria-label="Maker quote" {...FADE}>
              <div className={styles.firmHead}>
                <span className={styles.pxLabel}>Execution price <PriceKindTag kind="firm" /></span>
                <span className={expired ? `${styles.firmExpiry} warn` : styles.firmExpiry}>{expired ? "Expired" : secondsLeft === null ? "—" : `Valid ${formatCountdown(secondsLeft)}`}</span>
              </div>
              <span className={styles.firmPrice}>{price(liveQuote.quote.price)}</span>
              <div className={styles.firmFoot}>
                <span>{`${percentDistance(liveQuote.mark, liveQuote.quote.price)} vs mark`}</span>
                <span className="num">{`Maker ${shortAddress(liveQuote.quote.maker)}`}</span>
              </div>
              {!expired && secondsLeft !== null ? (
                <motion.div className={styles.expiryLine} initial={{ scaleX: Math.max(0, Math.min(1, secondsLeft / 20)) }} animate={{ scaleX: 0 }} transition={{ duration: Math.max(0, secondsLeft), ease: "linear" }} aria-hidden />
              ) : null}
              {expired ? <p className="t-small warn" style={{ margin: 0 }}>{copy.perps.staleQuote}</p> : null}
            </motion.div>
          ) : quoteVoided ? (
            <motion.p key="voided" className={styles.quoteState} {...FADE}>
              Inputs changed. Get a new quote.
            </motion.p>
          ) : quote.kind === "refused" ? (
            <motion.div key="refused" className={styles.quoteState} data-tone="warning" role="status" {...FADE}>
              <span>
                {quote.message}
                {quote.availableBase !== null && quote.availableBase > 0n && mark !== null ? (
                  <>
                    {` Available now: ${formatFixed(quote.availableBase, 18, 4)} ${m.base.symbol}. `}
                    <button type="button" className="btn-link" onClick={() => setSizeText(formatFixed((quote.availableBase! * mark) / WAD / scale, m.quote.decimals, 2, { group: false }))}>
                      Use available size
                    </button>
                  </>
                ) : null}
              </span>
            </motion.div>
          ) : quote.kind === "error" ? (
            <motion.p key="error" className={styles.quoteState} data-tone="negative" role="alert" {...FADE}>
              {quote.message}
            </motion.p>
          ) : (
            <motion.p key="none" className={styles.quoteState} {...FADE}>
              No firm price yet. A maker signs one when you get a quote.
            </motion.p>
          )}
        </AnimatePresence>

        <div className={styles.reference}>
          <span className={styles.pxLabel}>{copy.perps.markPrice} <PriceKindTag kind="reference" /></span>
          <span className={styles.refPrice}>{price(mark)}</span>
        </div>

        <dl className={`facts ${styles.estimates}`} aria-label="Risk details">
          <div>
            <dt>
              <span className={styles.pxLabel}>
                {copy.perps.liqPrice}
                <Hint label="About the liquidation estimate">{copy.leverageConsent.ack3}</Hint>
              </span>
            </dt>
            <dd>
              {numbers?.liq ? price(numbers.liq) : "—"}
              {numbers?.liq ? <span className="sub">{`${percentDistance(mark, numbers.liq)} from mark`}</span> : null}
            </dd>
          </div>
          {execPrice === null ? (
            <div>
              <dt>Estimated entry</dt>
              <dd>{numbers ? price(mark) : "—"}</dd>
            </div>
          ) : null}
          <div>
            <dt>{copy.perps.fee}</dt>
            <dd>{numbers ? collateral(numbers.fee, m) : "—"}</dd>
          </div>
          <div>
            <dt>{copy.perps.funding} (1h)</dt>
            <dd>
              {fundingPerHour(m.fundingRatePerSecondWad)}
              <span className="sub">{fundingPayer(m.fundingRatePerSecondWad)}</span>
            </dd>
          </div>
        </dl>
      </section>

      <dl className={`facts ${styles.marginSummary}`}>
        <div>
          <dt>Margin required</dt>
          <dd>
            {numbers ? collateral(numbers.margin, m) : "—"}
            {numbers && liveQuote && numbers.spreadCost > 0n ? <span className="sub">{`includes ${collateral(numbers.spreadCost, m)} quote spread`}</span> : null}
          </dd>
        </div>
        <div>
          <dt className={styles.withAction}>
            {copy.perps.availableMargin}
            {isConnected && !wrongChain ? (
              <button type="button" className="btn-link" onClick={() => setDepositOpen(true)}>
                {copy.portfolio.deposit}
              </button>
            ) : null}
          </dt>
          <dd>{isConnected && !wrongChain ? (acct === undefined ? "Unavailable" : collateral(free, m)) : "—"}</dd>
        </div>
      </dl>

      <p className={styles.riskNote}>{copy.perps.riskWarning}</p>

      <div className={styles.ctaWrap}>
        <WalletGate>
          <ActionButton disabled={cta.disabled} state={quote.kind === "requesting" ? "working" : "idle"} onClick={cta.action}>
            {cta.label}
          </ActionButton>
        </WalletGate>
      </div>

      {address ? (
        <ConsentDialog
          open={consentOpen}
          address={address}
          onAccept={() => {
            setConsentOpen(false);
            void getQuote();
          }}
          onBack={() => setConsentOpen(false)}
        />
      ) : null}
      <DepositDialog open={depositOpen} onOpenChange={setDepositOpen} />
      {review ? (
        <ReviewTradeDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setReview(null);
              setQuote({ kind: "none" });
            }
          }}
          m={m}
          side={review.side}
          signed={review.signed}
          quote={review.quote}
          margin={review.margin}
          fee={review.fee}
          liq={review.liq}
          leverageTenths={review.leverageTenths}
          secondsLeft={secondsLeft}
          onDone={() => setSizeText("")}
        />
      ) : null}
    </div>
  );
}
