# Recovery runbook

Every procedure keeps the contracts as the source of truth. Offchain services can be restarted or rebuilt without economic impact.

## Oracle relay stopped or wrong
1. Symptom: Status shows "Price delayed"; perps tickets show "Price updates are delayed. New leveraged trades are paused."
2. Contracts already fail closed after the one-hour heartbeat: no opens, increases, margin removal or liquidations. Reduce and close stay available when the losing side covers the transfer.
3. Anyone may call `ClearingHouse.triggerCloseOnly(marketId)` once a feed is stale. The keeper does this automatically.
4. Restart: `ROOQ_ENV=<env> ORACLE_OPERATOR_PRIVATE_KEY=... bun run apps/maker/src/relay.ts`.
5. A market in CLOSE_ONLY returns to ACTIVE only through `MarketPreflight.activatePerps(marketId)`, which rechecks feed freshness, backing, bond and bad debt onchain.
6. If the feed itself is compromised: oracle admin calls `OracleAdapter.revokeFeed(feedId)` (risk-reducing) and the guardian sets PAUSED or SETTLEMENT_PENDING.

## Maker unavailable
1. Symptom: "No executable quote is available right now." Positions stay open with their margin.
2. If the maker will not return, the guardian sets the market to SETTLEMENT_PENDING. Then anyone can call `settleAtMark(marketId, taker)` for each open pair at a fresh mark, without penalty, and both sides are released.

## Indexer or API down
1. The web app keeps trading and balances working from direct chain reads; charts, fills and activity show an explicit unavailable state.
2. Restart: `bun run apps/indexer/src/main.ts`. It resumes from its cursor. For a full rebuild: `bun run apps/indexer/src/replay.ts`, which rebuilds derived tables from stored canonical events.
3. Reorg: the indexer marks non-canonical rows and replays from the common ancestor; activity rows show "Receipt rechecking" meanwhile.

## RPC outage
Use another endpoint (`RPC_URL` for services, `NEXT_PUBLIC_RPC_URL` for the web build). The status bar shows "Connection issue" and writes are blocked until state can be read.

## Bad debt recorded
1. The ClearingHouse moves the market to CLOSE_ONLY automatically.
2. Investigate with `ClearingHouse.badDebt(marketId)` and the `BadDebtRecorded` event. Reactivation is blocked by preflight until bad debt is zero, which in V1 means a new market.

## Pause drill
`MarketRegistry.setPerpStatus(marketId, 4)` (PAUSED) by the guardian. Verify: trades revert with `MarketNotOpen(PAUSED)`, vault withdrawals of free balances still work. Return to CLOSE_ONLY with status 3. A guardian status change sets a hold: `activatePerps` reverts with `GuardianHold()` until the registry admin calls `MarketRegistry.releaseGuardianHold(marketId)`, then ACTIVE only via preflight.

## Funding shortfall recorded
`FundingShortfall(marketId, ...)` and a growing `ClearingHouse.unpaidFunding(marketId)` mean a paying side ran out of margin before it was liquidated. Nothing is drawn from the backstop. Check the keeper is running and liquidating; if the market keeps accruing shortfall, the guardian sets CLOSE_ONLY.

## Transaction shows "Submitted, but no receipt"
The web app stopped waiting after 120 s. The transaction may still land: open the hash link before retrying. Later steps in the same sequence were not sent.
