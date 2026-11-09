# ADR-P09: Funding owed/paid/shortfall, bad debt, economic bounds, parity

Status: DRAFT (W0). Decisions D1 to D4 below record the current economics as the reviewed baseline for the
private port. Changing any of them is a loss-allocation change and needs a founder decision (addendum 4.1).
Addendum refs: PERP-04, PERP-05, PERP-06, PERP-07, section 15 concern 1.

## Current rules, read from source (2026-11-08)

Funding (`contracts/src/lib/RiskMath.sol`, `ClearingHouse._accrue/_settleFunding`):

- Rate per second = `(maxRatePerHourWad / 3600) * skewWad / 1e18`, `skewWad = (longOi - shortOi) * 1e18 / (longOi + shortOi)`.
  Integer division truncates toward zero at each step.
- Accrual: on each touch, `dt = now - lastFundingTime`, capped at `MAX_FUNDING_WINDOW = 3600`. First touch and
  touches with a stale price advance the clock without accruing (the gap is never charged later).
- Index delta = `rate * dt * mark / 1e18` (truncating).
- Pair settlement: `owed = sign(size * delta) * ceil(|size * delta| / (1e18 * scale))`, positive means taker pays.
  Magnitude rounds up for either direction; the receiver gets exactly what the payer pays, so rounding moves value
  between the two pair sides and never creates it.
- Payment: `paid = min(owed, payer's pair-domain balance)` moved payer to receiver. `owed - paid` is added to
  `MarketState.unpaidFunding` and `FundingShortfall(market, payer, amount, total)` is emitted.
- Funding never touches insurance or the creator bond (`test_fundingShortfallDoesNotDrawBackstop`).

Loss waterfall (`_payWithBackstop`, `_chargePenalty`, `_recordBadDebt`):

- Realized PnL at close/liquidation/settle-at-mark is paid from the loser's pair margin; any gap is requested from
  `MarketBackstop.coverShortfall` (this market's insurance, then this market's creator bond); the remainder is
  recorded in `badDebt[market]` and the market is forced CLOSE_ONLY. The winner is short-paid by that remainder.
- Liquidation penalty is capped by the liquidated side's remaining pair balance; half to the caller, half to
  this market's insurance.

## Decisions

D1. SUPERSEDED for the private system by `DECISION_LOG.md` D-03 (legacy contracts keep this rule). Funding shortfall is written off. It is not a claim against the payer, not collected at close, and not
covered by insurance or bond. The receiver is short-paid. Rationale: matches current behavior exactly (pinned by
`test_fundingShortfallIsWrittenOffAtClose`); a payer at zero pair margin is already near liquidation, where the
loss waterfall governs. The previous source comment claiming recovery "at close" was wrong and was corrected.
Alternative for founder review: a per-pair `fundingDebt` field netted against the payer's realized PnL at close,
ahead of the backstop. That would make the receiver whole more often but changes loss allocation.

D2. Funding receipts carry both amounts. `FundingSettled(marketId, taker, maker, takerOwed, takerPaid)`; same
sign, `|takerPaid| <= |takerOwed|`. Private receipts (UX-05), analytics and the risk-kernel reference must use the
same three quantities: owed, paid, shortfall = |owed| - |paid|. Legacy indexer stores `taker_owed` and
`taker_paid` (migration 3); `positions.funding_paid` sums `takerPaid` only.

D3. One-hour accrual cap and stale-price freeze are retained for the private port as an explicit decision.
Consequence (already in `docs/known-risks.md`): funding for untouched gaps longer than one hour is under-charged.
In the private design the coordinator, not users, drives accrual each epoch, so the cap binds only when epochs
stall. ADR-P05 must bind funding accrual to epoch advancement so a coordinator cannot stall it selectively.

D4. Bad debt stays market-isolated: insurance then bond of the same market, then a recorded short-payment of the
winning side, CLOSE_ONLY forced. No auto-deleveraging, no cross-market or spot-LP subsidy (STATE-04, SPOT-06). The
short-paid amount is not a recoverable claim in V1. Frozen settlement must replace the sequential
`coverShortfall` order with an entitlement computed over the full affected claim set (REC-04, PV-21); that
algorithm is owned by ADR-P08.

## Parity requirement for the private port

The circuit/guest implementation, the Solidity legacy contracts (for migration exits) and `crates/risk-kernel`
must agree bit-for-bit on: rate, index delta, owed (rounding up in magnitude), paid, shortfall, PnL floor/trunc,
fees, penalty, and waterfall amounts. The kernel currently models `funding_owed` but not `paid`/`shortfall`; W3A
adds them and extends `contracts/test/vectors/risk_vectors.json`. The independent oracle of correctness must not
call the implementation under test (addendum section 17).

## Tests

- `contracts/test/W0SourceConcerns.t.sol`: owed vs paid in the event, write-off at close.
- `contracts/test/ReviewFindings.t.sol`: shortfall never draws backstop; one-hour cap.
- `apps/indexer/test/reducers.test.ts`: `fundingPaid` sums paid, history keeps owed and paid.
- To add in W3A: kernel property tests for owed/paid/shortfall over max ranges, negative and zero funding,
  delayed touches (PV-09).
