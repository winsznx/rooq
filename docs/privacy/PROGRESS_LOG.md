# Rooq private V1: progress log

Updated 2026-11-09. Rooq is live on Robinhood Chain testnet.

## What is live

| Part | Where |
|---|---|
| Website and app | https://rooq.trade |
| Docs | https://docs.rooq.trade |
| Backend | https://api.rooq.trade, on the kordaen VPS |
| Contracts | `contracts/deployments/privacy-46630.json`, all 27 verified on Sourcify |

The full loop ran on the production site with a real wallet and real proofs: open an account, shield, seed all five USDG pools, swap, open and close a TSLA perp, unshield through the relayer. Evidence is in `docs/privacy/evidence/live-testnet-46630.txt`.

## Operating notes

- Both risk workers run on one VPS, by founder decision.
- The maker has one 100 USDG lock per market. Size is capped at about 160 USD of notional per order.
- Prices come from a single-operator test relay of Robinhood's reference prices.
- The key guardian is the deployer wallet.
- Workers take over spot and liquidity if the coordinator stops. Perps fall back to forced exit.
- `rooq-health` shows read-api and relayer as failing because it checks loopback. Check them at https://api.rooq.trade.
- Rooq has not been audited.

## Decisions

All decisions are in `docs/privacy/DECISION_LOG.md`.
