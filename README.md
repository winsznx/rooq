# rooq

Private trading for Stock Tokens on Robinhood Chain testnet (chain 46630): shielded balances, private spot pools and private 2x perps on five markets (TSLA, AMZN, PLTR, NFLX, AMD). Testnet only. It has not been audited, the risk settings aren't calibrated, and test assets have no value.

The private system (`contracts/src/privacy`, `zk/circuits`, `packages/private-sdk`, `apps/private-services`) is the product. It works end to end on local chains with real proofs and has not been deployed to testnet yet. Prices come from a single-operator TEST relay of Robinhood's public price API, because no Chainlink feeds are published for this testnet. The transparent reference build (`contracts/src/perps`, `apps/maker`, `apps/indexer`, `apps/api`) is older and is not private.

Status, evidence and open gaps: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Running the backend on a server: [docs/privacy/VPS_RUNBOOK.md](docs/privacy/VPS_RUNBOOK.md). Product and design specs: `internal/ROOQ_PRODUCT_SPEC/` (never served publicly).

Build agents must read the [private V1 implementation addendum](internal/ROOQ_PRODUCT_SPEC/01-PRODUCT/PRIVATE_V1_ADDENDUM.md) before extending the current implementation. It defines the required privacy model, complete release scope, recovery paths and acceptance evidence.

## Layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry. Private system in `src/privacy/` (PrivatePairs, PrivateSpot, PrivateMarkets, generated Honk verifiers), transparent reference contracts in `src/perps`, `src/spot`, `src/market`, shared `src/oracle`. Tests in `test/`, deploy scripts in `script/` |
| `zk/circuits/` | Noir circuits for custody, perps, spot and recovery, compiled by `build.sh` |
| `packages/private-sdk/` | Notes, keys, witnesses, encryption and proving, used by the browser and the services |
| `apps/private-services/` | Read API, relayer, queue, coordinator, two risk workers, maker and TEST price relay, one process each |
| `crates/risk-kernel/` | Rust reference model of the settlement math; generates the parity vectors |
| `packages/sdk/` | Typed ABIs, EIP-712 quote types, estimators with contract parity, error mapping, formatting |
| `packages/config/` | Chains, verified testnet assets, deployed addresses |
| `packages/ui/` | Brand tokens and the canonical copy deck, synced from the spec |
| `apps/web/` | Next.js app on http://localhost:3200 |
| `apps/maker/` | Transparent reference build: quote signer, TEST oracle relay, keeper |
| `apps/indexer/`, `apps/api/` | Transparent reference build: Postgres indexer and REST/SSE API on http://127.0.0.1:8700/api/v1 |
| `e2e/` | Onchain walkthrough, Playwright browser flow, accessibility suite, screenshot tool |
| `config/` | Provisional risk tiers (`risk-testnet.json`) and per-environment deploy configs |
| `infra/vps/` | systemd unit, env-file generator, release builder, health check and Caddy config for a Linux server |
| `docs/` | ADRs, test plan, deployments, risks, evidence, screenshots |

## Requirements
Node 24, pnpm 12, Bun 1.4, Foundry 1.7, Rust 1.94, PostgreSQL 16 on the `/tmp` socket (local).

## Run everything locally

    pnpm dev:all

Starts both local chains, the deployed contracts, the indexer and API, the maker and risk services, the private services, and the web app on http://localhost:3200. `scripts/local-up.sh` is the source of truth for ports and logs (`.local-logs/`).

Then open http://localhost:3200. With `NEXT_PUBLIC_LOCAL_TEST_WALLET=1` in `apps/web/.env.local`, the connect dialog offers a "Local test wallet" that signs with an anvil dev account, so every action is a real local transaction.

## Tests

```bash
cd contracts && forge test                                   # unit, fuzz, invariant, parity
pnpm --filter @rooq/private-services test                    # service unit tests
cd e2e && RPC=http://127.0.0.1:8547 bun run private/offline-liquidation.ts  # private perps lifecycle, real proofs (needs anvil on 8547 with --code-size-limit 100000)
```

Last results and evidence paths are in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Deploy private V1 to Robinhood Chain testnet

Not done yet. `scripts/deploy-private-testnet.sh` simulates against the live chain; it fetches current prices, deploys five tier B markets, and prints the web app's `NEXT_PUBLIC_PRIVATE_MARKET_MAP` and `NEXT_PUBLIC_PRIVATE_POOL_MAP`. Pass `--broadcast` to deploy for real. Keys stay in the macOS Keychain. Then follow [docs/privacy/VPS_RUNBOOK.md](docs/privacy/VPS_RUNBOOK.md) to run the services.

The older transparent deployment script (`scripts/deploy-testnet.sh`) still exists for the reference build.

Mainnet is disabled in code and needs an audit, quant review and legal review first.
