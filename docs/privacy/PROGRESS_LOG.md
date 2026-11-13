# Rooq private V1: progress log

Updated 2026-11-13. Rooq is live on Robinhood Chain testnet.

## What is live

| Part | Where |
|---|---|
| Website and app | https://rooq.trade |
| Docs | https://docs.rooq.trade |
| Backend | https://api.rooq.trade, on the kordaen VPS |
| Contracts | `contracts/deployments/privacy-46630.json`, all 27 verified on Sourcify, PrivatePairs also on the testnet explorer |

The full loop ran on the production site with a real wallet and real proofs: open an account, shield, seed all five USDG pools, swap, open and close a TSLA perp, unshield through the relayer. Evidence is in `docs/privacy/evidence/live-testnet-46630.txt`.

## Operating notes

- Both risk workers run on one VPS, by founder decision.
- Each market has 600 USDG of maker backing with a 24-hour expiry. It lapses daily and is reposted with `apps/web/scripts/post-backing.mjs`. Largest fill is about 300 USD of notional.
- Pools hold about 1,700 to 3,000 USDG per side and are kept on the oracle price by `apps/web/scripts/rebalance-pools.mjs`.
- Prices come from a single-operator test relay of Robinhood's reference prices.
- The key guardian is the deployer wallet.
- Workers take over spot and liquidity if the coordinator stops. Perps fall back to forced exit.
- `rooq-health` shows read-api and relayer as failing because it checks loopback. Check them at https://api.rooq.trade.
- Rooq has not been audited.

## Decisions

All decisions are in `docs/privacy/DECISION_LOG.md`.
