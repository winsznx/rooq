# Implementation status

Updated 2026-11-13. Rooq's private system is deployed on Robinhood Chain testnet (46630) and runs at https://rooq.trade. It has not been audited.

## What is live

| Area | State | Evidence |
|---|---|---|
| Contracts | Deployed and source-verified on Sourcify. `PrivatePairs` is also verified on the testnet explorer | [contracts/deployments/privacy-46630.json](contracts/deployments/privacy-46630.json), [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md) |
| Circuits | 17 production circuits, Noir 1.0.0, Barretenberg UltraHonk (bb 5.3.0). Artifact and verifier hashes are pinned | [zk/circuits/keys/toolchain.txt](zk/circuits/keys/toolchain.txt) |
| Shield, transfer, unshield | Live | [docs/privacy/evidence/live-testnet-46630.txt](docs/privacy/evidence/live-testnet-46630.txt) |
| Private spot | Live: one-pool and two-pool routes, minimum enforced on chain, refund at expiry | same |
| Private liquidity | Live: add, remove, return to idle | same |
| Private perps | Live on five markets (TSLA, AMZN, PLTR, NFLX, AMD), 2x, IMR 0.5, MMR 0.35: open, add or remove margin, reduce, close, funding, liquidation, forced exit | same |
| Maker backing | Live: private locks with open and close spreads | same |
| Recovery | Account rebuilt from chain data on any device, by wallet signature or passkey. Interrupted operations resume | [apps/docs/content/recovery.md](apps/docs/content/recovery.md) |
| Services | Read API, relayer, queue, coordinator, two risk workers, maker and test price relay, under systemd on one VPS | [docs/privacy/VPS_RUNBOOK.md](docs/privacy/VPS_RUNBOOK.md) |
| Web and docs | Next.js on Vercel. Public market data loads before the proving runtime | https://rooq.trade, https://docs.rooq.trade |

The full loop ran on the production site with a real wallet and real proofs: open an account, shield, seed all five pools, swap, open and close a TSLA perp, unshield through the relayer.

## Test coverage

| Suite | What it covers | In CI |
|---|---|---|
| `forge test` | Contracts: unit, fuzz, invariant and parity against the Rust kernel | Yes |
| `cargo test --workspace` | Rust risk kernel and vector generation | Yes |
| `@rooq/private-sdk` | Notes, keys, encryption, scanning and real proofs against the compiled circuits | Yes |
| `@rooq/private-services` | Service unit tests | Yes |
| `e2e/private/*.ts` | Shielded flow, spot flow and the full perps lifecycle with real proofs on a local chain | No, run by hand. Results in [docs/privacy/evidence/](docs/privacy/evidence/) |

## Known limits on testnet

- Both risk workers run on one server, so one outage stops both. They hold separate keys.
- Prices come from a single-operator test relay of Robinhood's reference prices, not an independent oracle.
- The key guardian, which can replace operator keys after a 24-hour delay, is the deployer wallet. It can't move funds or change markets.
- Shields and unshields are public. Timing and amounts can link them.
- Markets are fixed at deployment. Adding one means a new deployment.
- Not audited.

Decisions behind each of these are in [docs/privacy/DECISION_LOG.md](docs/privacy/DECISION_LOG.md).
