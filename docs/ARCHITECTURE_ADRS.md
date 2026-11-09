# Architecture decision records

Each record states the decision, why, and what it costs. Decisions can be revised with technical proof (05-DELIVERY/ASSUMPTIONS_DECISIONS_AND_OPEN_ITEMS.md).

## ADR-001 Perps settle as matched pairs
A perp position is one taker and the maker who signed its quote. Both post isolated margin inside the pair's own vault domain. PnL and funding move as a single integer from one side's margin to the other's.
- Why: debits equal credits by construction (I-01, I-02, T-003, T-004, T-005 hold exactly, not within a tolerance), and each pair is its own insolvency domain.
- Cost: V1 allows one maker per taker position per market and no flip in one trade. If the maker side falls below maintenance, the pair closes at the mark and the taker is paid in full. Multi-maker aggregation is roadmap stage 2.

## ADR-002 One collateral vault, domain ledger, no owner
MarginVault holds the only collateral token and a `(domain, account)` ledger. Only FREE balances are withdrawable by their owner. Two operator contracts (ClearingHouse, MarketBackstop) are wired once at deploy; there is no owner, no sweep and no way to add an operator later. Total ledger is capped at int256 max so signed arithmetic downstream cannot wrap.

## ADR-003 Funding follows open-interest skew
`rate = maxRate * (longOI - shortOI) / (longOI + shortOI)`, accrued continuously into a per-market index and settled pair by pair, magnitude rounded up against the payer.
- Why: computed only from onchain state, so it cannot be pushed around by a thin pool price, and it is identical in Rust, Solidity and TypeScript.
- Cost: no premium-to-index term in V1. With a stale price the index freezes instead of moving on invented data.

## ADR-004 Solidity is authoritative; Stylus is not used
Robinhood Chain testnet answers `ArbWasm.stylusVersion() = 3`, which shows the precompile exists, not that a deploy works end to end. No Stylus canary was deployed (no funded key). The Rust crate is a reference model checked against Solidity on 1,400 vectors and two full lifecycles (T-015).

## ADR-005 Testnet prices come from a labelled relay
No Chainlink testnet feed addresses are published for Robinhood Chain (docs.chain.link returns 404 for the network). Each market gets an AggregatorV3-compatible `MockPriceFeed` written by one operator from `api.robinhood.com/rhj/prices`, mid of bid and ask times `currentMultiplier`, which matches the onchain Stock Token feed convention. The relay writes nothing when the source is halted or older than 120 s, so the one-hour heartbeat makes positions pause by themselves. Feeds are approved per token address, so a feed for one asset cannot back another.

## ADR-006 Asset identity is the address
Testnet USDG is `0x7E955252E15c84f5768B83c41a71F9eba181802F`, the address Paxos lists for "Robinhood Testnet". The five testnet Stock Tokens (TSLA, AMZN, PLTR, NFLX, AMD) were identified by their deployer, a verified `StockFactory` at `0x2DD5b0Ea7c29006bA9450B9a4f3ADc234409e5Da`, and confirmed by ERC-8056 `uiMultiplier()` and `uid()` onchain. Copycat tokens with the same tickers exist; four are listed as known impostors. Logos are the issuer's own Robinhood CDN images for the same asset, loaded at runtime with provenance, never letter tiles.

## ADR-007 Read-only views live in PerpLens; ClearingHouse compiles with via-IR
ClearingHouse was 456 bytes over the 24 KB EIP-170 limit. Health and liquidation-estimate views moved to `PerpLens`, which has no authority. The review fixes of 2026-11-07 (stale-reduce guard, funding shortfall accounting, fee source) pushed it over again, so `foundry.toml` compiles only `ClearingHouse.sol` with `via_ir = true` (200 runs) through `compilation_restrictions`; everything else keeps the legacy pipeline. Result: 23,256 bytes, 1,320 under the limit. Side effect in tests: via-IR caches `block.timestamp` across `vm.warp` within one test, so tests read time with `vm.getBlockTimestamp()`. Verification must use the same per-file settings: `scripts/verify-testnet.sh` passes `--compilation-profile size` for ClearingHouse and `default` for the rest (checked with `--show-standard-json-input`: viaIR true and false respectively, 200 runs). Without the flag, forge refuses with "Ambiguous compilation profiles".

## ADR-008 Own constant-product pools; router only swaps
Pools track reserves internally (donations cannot move price or inflate shares) and check every inbound transfer by balance delta (fee-on-transfer tokens revert). Liquidity is added and removed on the pool directly with one exact approval; the router only routes exact-input swaps through factory pools and ends every call holding nothing.

## ADR-009 Reduce and close survive a stale price, liquidation does not
Opening, increasing, removing margin and liquidating require a fresh price. Closing stays available with a stale price because it settles bilaterally at the maker-signed price, and only when the losing side's margin covers the whole transfer, so the backstop is never drawn by an unpriced trade. A partial reduce at a stale price reverts with `StaleReduceMustClose`: without a fresh mark, a maker-signed off-market price on a small reduce could otherwise move most of the counterparty's margin while leaving the position open (found in review, regression test `test_stalePartialReduceAtOffMarketPriceReverts`).

## ADR-010 Frontend stack and layout
Next.js 16 App Router, wagmi 2 and viem 2, TanStack Query, Radix primitives, Motion for state transitions only, Lightweight Charts for real candles. Styling is plain CSS over the brand token file (no utility framework, so no incidental default colours). The trade route uses the 64 px compact rail below 1920 px so the chart keeps its minimum width (teardown rule e.8). The ticket shows derived margin after the leverage field it depends on (teardown rule 8). Leverage is a numeric field with presets, defaulting to 1.0x, never a slider and never preselected at the cap.

## ADR-011 Margin at the cap includes the quote spread
Onchain, equity after the fill must cover initial margin at the mark, and the maker's spread counts against equity at once. The ticket therefore asks for `max(size / leverage, IM - spread PnL)` plus a 0.25% buffer for a relay update, and says "includes N quote spread". Effective leverage at the cap is a little under the cap.

## ADR-012 Writes simulate, estimate gas, then send with a 25% buffer
A browser E2E close reverted with `ReentrancySentryOOG` because the node's estimate was tight once funding settlement added vault moves. Every write now simulates, estimates explicitly and sends with a 25% gas buffer.

## ADR-013 Funding never draws on the backstop, and accrues at most one hour per touch
If the paying side's margin cannot cover funding owed, the shortfall is paid as far as margin allows and the rest is recorded in `unpaidFunding(marketId)` with a `FundingShortfall` event. It is not bad debt and does not touch insurance or the creator bond, which exist for liquidation gaps. Each accrual counts at most `MAX_FUNDING_WINDOW` (one hour) of elapsed time, so a market nobody touched for a day cannot settle a day of funding at whatever price arrives first. The Rust kernel mirrors the cap and the parity vectors were regenerated.

## ADR-014 Guardian close-only holds until the admin releases it
A guardian `setPerpStatus` to a risk-reducing state sets `guardianHold`. `MarketPreflight.activatePerps` reverts with `GuardianHold()` until `releaseGuardianHold(marketId)` is called by the registry admin. Without the hold, anyone could reactivate a market the guardian had just stopped as soon as preflight checks passed. The preflight and clearing-house roles are administered by a locked role nobody holds, so the registry admin cannot grant them to itself.

## ADR-015 Offchain readers tolerate hostile markets
Market creation and pool creation are permissionless, so one market's token can revert on `symbol()` or `decimals()`. The web app reads each market independently and drops unreadable ones with a console warning; the indexer leaves tokens with unreadable or over-18 decimals out of `contract_meta` (reducers already treat unknown decimals as "no normalised price") and only retries on transport errors. Neither can be stopped by one bad token.
