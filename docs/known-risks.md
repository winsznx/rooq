# Known risks and limits

Rooq is unaudited testnet software. None of this is safe for real money.

## Financial model
- Risk parameters in `config/risk-testnet.json` are provisional and uncalibrated (no quant review).
- Liquidation closes the whole pair at the oracle mark. Gaps beyond margin draw on market insurance, then the creator bond; anything left is recorded as bad debt and the market goes close-only. There is no auto-deleveraging, so a winning side can be short-paid by the recorded amount.
- When a maker's side of a pair falls below maintenance, the pair closes at the mark and the taker is paid in full; the taker loses the position, not money.
- Funding follows open-interest skew only and is capped at 0.01% per hour on tier S. Each accrual counts at most one hour of elapsed time, so funding for long untouched gaps is under-charged by design.
- Funding a paying side cannot cover is recorded as `unpaidFunding` and the receiving side is short-paid by that amount. The gap is written off: it is not collected at close and never draws on insurance or the creator bond (ADR-P09 D1).
- With a stale price, a position can be closed in full but not partially reduced.
- Positive unrealised PnL counts toward a side's health only up to the margin the other side has posted.

## Oracle and data
- Testnet feeds are a single-operator relay of Robinhood's public reference price. The operator key can set any price within the feed bounds; this is labelled "Testnet sample" in the app. No sequencer uptime feed is configured on testnet.
- The relay does not model market sessions beyond what the source reports (`isTradingHalt`, source age). Off-hours prices follow the source.

## Privileged roles (testnet: all held by the deployer)
- Registry admin sets tiers and quote assets within bounds fixed at deploy, and releases guardian holds. Guardian can only reduce risk. Oracle admin approves or revokes feeds and cannot repoint an existing feed id. None of them can move user collateral.
- Contracts are not upgradeable. A fix means a new deployment and migration.

## Product limits (V1)
- One maker per taker position per market; no position flip in one trade; market orders only (RFQ).
- New markets launch spot-only unless an approved feed exists for the token; feed approval is admin-gated.
- Market creation is first-come per (base, quote): anyone can register a market for a token before its issuer does, with any pool fee tier. The app marks non-canonical tokens as unverified but cannot stop squatting.
- SpotFactory has no token allowlist. Pools can hold any contract that passes the balance-delta checks; reverting or fee-on-transfer tokens fail closed in the pool, and offchain readers skip them.
- The maker quote service reserves capacity per outstanding quote for its 20-second life, keyed by market and taker. A filled quote is briefly double-counted, so it may refuse slightly early; the ClearingHouse enforces the real limit.
- Quotes from the maker service are indicative until the ClearingHouse verifies them.
- Stock Tokens provide price exposure. They do not give shares or shareholder rights. Availability varies by jurisdiction; no geography controls are implemented on testnet.

## Not done
External audit, economic review, legal review, bug bounty, redundant oracles and keepers, incident drill.
