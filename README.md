# Rooq

Private markets for Stock Tokens on Robinhood Chain. Swap TSLA, AMZN, PLTR, NFLX and AMD, trade their price with up to 2x leverage, provide liquidity or back perps as a maker, without your balances or positions showing on chain.

Live on Robinhood Chain testnet (chain 46630). Test assets have no value. Rooq has not been audited.

- App: https://rooq.trade
- Docs: https://docs.rooq.trade
- API health: https://api.rooq.trade/health
- Status: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)

## How it works

Funds enter by shielding, a public deposit into the `PrivatePairs` contract. After that, balances live as notes: Poseidon2 commitments in a depth-32 Merkle tree, encrypted to the owner, spent with a zero-knowledge proof and a nullifier. Swaps, perps, liquidity and transfers are proven in Noir and checked on chain by generated UltraHonk verifiers. A relayer submits the transactions, so the user's wallet never signs them. Withdrawals (unshields) are public.

Not everything is hidden from everyone. The coordinator sees the terms of the locks it matches, risk workers decrypt open positions so funding and liquidation work while traders are offline, and both see one-time addresses rather than wallets. [How privacy works](https://docs.rooq.trade/how-privacy-works) lists exactly who sees what.

## Repository layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry. The private system is in `src/privacy/`: `PrivatePairs` (custody, note tree, perps, funding, forced exits), `PrivateSpot` (pools and liquidity), `PrivateMarkets` (market settings, bonds, key rotation) and the generated verifiers. Tests in `test/`, deploy scripts in `script/`, broadcasts in `deployments/` |
| `zk/circuits/` | 17 Noir circuits (custody, spot, liquidity, perps, funding, liquidation, exits, insurance) plus a math probe. `build.sh` compiles them and writes the Solidity verifiers |
| `packages/private-sdk/` | Notes, keys, witnesses, encryption, proving and chain scanning. Used by the browser and the services |
| `apps/private-services/` | Read API, relayer, queue, coordinator, two risk workers, maker and the test price relay, one process each |
| `apps/web/` | Next.js app: landing page and the private trading app |
| `apps/docs/` | Next.js documentation site |
| `crates/risk-kernel/` | Rust reference model of the settlement math. Generates the parity vectors that contracts, circuits and SDK are tested against |
| `packages/sdk/`, `packages/config/`, `packages/ui/` | Fixed-point math and formatting, chain and asset config, design tokens and copy |
| `e2e/` | End-to-end flows with real proofs, browser flows and screenshot tooling |
| `infra/vps/` | systemd units, env-file generator, release builder, health check and Caddy config |
| `docs/` | Architecture decisions, privacy design notes, deployments, test evidence and screenshots |

`contracts/src/perps`, `src/spot`, `src/market`, `apps/maker`, `apps/indexer` and `apps/api` are an earlier transparent reference build. They are not private and are not what runs at rooq.trade.

## Requirements

Node 24, pnpm 12, Bun 1.4, Foundry 1.7, Rust 1.94, nargo 1.0.0 and bb 5.3.0 for the circuits. PostgreSQL 16 for the reference build only.

## Run locally

    pnpm install
    pnpm dev:all

This starts local chains, deploys the contracts, and runs the services and the web app on http://localhost:3200. `scripts/local-up.sh` is the source of truth for ports and logs (`.local-logs/`). With `NEXT_PUBLIC_LOCAL_TEST_WALLET=1` in `apps/web/.env.local`, the connect dialog offers a local test wallet backed by an anvil dev account.

## Tests

```bash
(cd zk/circuits && nargo compile --workspace)                # compile the circuits first
(cd contracts && forge test)                                 # unit, fuzz, invariant and parity tests
cargo test --workspace                                       # Rust risk kernel
pnpm --filter @rooq/private-sdk test                         # SDK against the compiled circuits, real proofs
pnpm --filter @rooq/private-services test                    # service unit tests
(cd e2e && RPC=http://127.0.0.1:8547 bun run private/offline-liquidation.ts)  # full perps lifecycle, real proofs
```

CI runs a quick install, typecheck and SDK test on every push. The full suites run locally. Recorded results are in [docs/privacy/evidence/](docs/privacy/evidence/).

## Deployment

The testnet deployment is recorded in [contracts/deployments/privacy-46630.json](contracts/deployments/privacy-46630.json) and listed in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md). Contracts are source-verified on Sourcify, and `PrivatePairs` is also verified on the [testnet explorer](https://explorer.testnet.chain.robinhood.com/address/0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5?tab=contract).

`scripts/deploy-private-testnet.sh` deploys a fresh instance (simulates by default, `--broadcast` to deploy). [docs/privacy/VPS_RUNBOOK.md](docs/privacy/VPS_RUNBOOK.md) covers running the services on a server. Mainnet is disabled in code.

## License

Contracts carry their license in each file's SPDX header (BUSL-1.1 for the private system, Apache-2.0 and MIT elsewhere).
