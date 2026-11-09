# Rooq implementation status

Updated 2026-11-09. Statuses use only: NOT STARTED, IN PROGRESS, TESTED LOCAL, DEPLOYED TESTNET, VERIFIED TESTNET, BLOCKED.
Nothing here is deployed to Robinhood Chain testnet yet. Rooq has not been audited, and the risk settings in `config/risk-testnet.json` are provisional and unreviewed.

Two things share this repo. The private system (shielded custody, perps, spot, liquidity, makers, created markets) is the product: see "Private V1" below and `docs/privacy/PROGRESS_LOG.md`. The transparent reference build in the Modules table is older and isn't private. Evidence for the transparent build is in `docs/evidence/`, for the private system in `docs/privacy/evidence/`. Commands are run from the repo root unless a directory is shown.

## Modules

| Specification | Code path | Test command | Status | Risks | Evidence | Owner |
|---|---|---|---|---|---|---|
| Repo, workspaces, pinned toolchain | `package.json`, `pnpm-workspace.yaml`, `Cargo.toml`, `contracts/foundry.toml` | `pnpm install && pnpm -r typecheck` | TESTED LOCAL | pnpm 12 build approvals: esbuild allowed, three optional native addons denied | `pnpm-lock.yaml` | Rooq |
| MarginVault (custody, ledger, withdrawal lock) CONTRACT_MAP | `contracts/src/perps/MarginVault.sol` | `cd contracts && forge test --match-contract MarginVault` | TESTED LOCAL | Operators wired once at deploy; no owner, no sweep | `docs/evidence/01-forge-test.txt` | Rooq |
| QuoteVerifier (EIP-712, nonce bitmap, partial fills, delegated signer) | `contracts/src/perps/QuoteVerifier.sol` | `forge test --match-contract QuoteVerifier` | TESTED LOCAL | EIP-1271 maker wallets intentionally unsupported in V1 | same | Rooq |
| ClearingHouse (matched pairs: open, increase, reduce, close, funding, liquidation, settle at mark) | `contracts/src/perps/ClearingHouse.sol` | `forge test --match-contract "ClearingHouse|LiquidationFunding"` | TESTED LOCAL | One maker per taker position per market; full (not partial) liquidation; no ADL; partial reduce needs a fresh price. Compiled alone with via-IR: 23,256 B (1,320 B under EIP-170), ADR-007 | same | Rooq |
| MarketBackstop (per-market insurance, creator bond, waterfall) | `contracts/src/perps/MarketBackstop.sol` | `forge test --match-test "Backstop|Bond|T006"` | TESTED LOCAL | Backstop sizes are provisional | same | Rooq |
| OracleAdapter (fail-closed, asset-bound feeds) | `contracts/src/oracle/OracleAdapter.sol` | `forge test --match-test "Stale|Oracle|T011"` | TESTED LOCAL | No sequencer uptime feed configured: none is published for testnet | same | Rooq |
| Testnet price feeds | `contracts/src/oracle/MockPriceFeed.sol`, `apps/maker/src/relay.ts` | `ROOQ_ENV=local ORACLE_OPERATOR_PRIVATE_KEY=... bun run apps/maker/src/relay.ts` | TESTED LOCAL | Single-operator TEST relay of api.robinhood.com/rhj/prices, labelled "Testnet sample" everywhere. Chainlink testnet feed addresses are not published (see Blockers) | relay log in `docs/evidence/README.md` | Rooq |
| MarketRegistry (identity, status machine, immutable global bounds) | `contracts/src/market/MarketRegistry.sol` | `forge test --match-contract Preflight` | TESTED LOCAL | Guardian and admin are the deployer on testnet | same | Rooq |
| MarketPreflight (previewAsset, previewEligibility, activatePerps rechecks live state) | `contracts/src/market/MarketPreflight.sol` | `forge test --match-contract Preflight` | TESTED LOCAL | Feed approval is admin-gated, so permissionless markets launch spot-only until a feed is approved | same, plus T09 in walkthrough | Rooq |
| PerpLens (health, liquidation estimate) | `contracts/src/perps/PerpLens.sol` | exercised by walkthrough T08 | TESTED LOCAL | Read-only | `docs/evidence/walkthrough-local.json` | Rooq |
| Spot engine (factory, constant-product pool, router) | `contracts/src/spot/*` | `forge test --match-contract Spot` | TESTED LOCAL | Not a Uniswap fork; no concentrated liquidity | `docs/evidence/01-forge-test.txt` | Rooq |
| Stateful invariants (conservation, OI = sum of pairs, full attribution) | `contracts/test/invariant/PerpInvariants.t.sol` | `forge test --match-path "test/invariant/*"` | TESTED LOCAL | 128 runs x 64 calls; deeper CI profile available | same | Rooq |
| Offline liquidation prototype (W2): PrivatePairs, lock/open_pair/liquidate/release/funding_epoch circuits, SDK pairs module | `contracts/src/privacy/PrivatePairs.sol`, `zk/circuits/`, `packages/private-sdk/src/pairs.ts` | `zk/circuits/build.sh`; `cd contracts && forge test --match-contract PrivatePairs`; `cd packages/private-sdk && pnpm exec vitest run`; `anvil --port 8547 --code-size-limit 100000 & cd e2e && RPC=http://127.0.0.1:8547 bun run private/offline-liquidation.ts` | TESTED LOCAL | Perp lifecycle candidate: bond and haircut stages absent. Measured local gas about 3.5M to 4.5M per operation; proof batching not built | `docs/privacy/ADR-P05-risk-and-liquidation.md`, `docs/privacy/evidence/w2-offline-liquidation-local.json` | Rooq |
| Private custody slice (W1): ShieldedPool, append/spend circuits, wallet SDK | `contracts/src/privacy/`, `zk/circuits/`, `packages/private-sdk` | `zk/circuits/build.sh`; `cd contracts && forge test --match-contract ShieldedPool`; `cd packages/private-sdk && pnpm exec vitest run`; `anvil --port 8547 & cd e2e && RPC=http://127.0.0.1:8547 bun run private/shielded-flow.ts` | TESTED LOCAL | Incomplete fixture of private V1. Measured local gas: spend about 3.85M, append batch about 3.95M; per-op verification until batch folding lands. Root expiry after 64 batches not yet tested. A relayer fee on a private transfer would reveal the asset, so private transfers currently carry no relayer fee (open, ADR-P04) | `docs/privacy/evidence/w1-shielded-flow-local.json`, `zk/circuits/keys/toolchain.txt` | Rooq |
| Rust risk kernel and parity vectors (T-015) | `crates/risk-kernel`, `contracts/test/RiskParity.t.sol`, `contracts/test/vectors/risk_vectors.json` | `cargo test --workspace && cargo run --bin gen-vectors && cd contracts && forge test --match-contract RiskParity` | TESTED LOCAL | Not authoritative onchain; Stylus not used | `docs/evidence/02-cargo-test.txt` | Rooq |
| TypeScript SDK (ABIs, EIP-712, estimators, error map, formatting) | `packages/sdk` | `pnpm --filter @rooq/sdk test` | TESTED LOCAL | Estimators are previews; contracts recompute | 14 vitest tests incl. parity and decimal-comma rejection | Rooq |
| Chain and asset registry (canonical testnet USDG and Stock Tokens) | `packages/config/src/{chains,tokens}.ts` | manual onchain checks recorded in file | TESTED LOCAL | Company logos vendored in `apps/web/public/logos` (Robinhood's asset API serves one generic placeholder for every Stock Token, so it cannot identify assets); local fixtures show the logo of the asset they stand in for and stay labelled Test fixture; brand-use review pending | `docs/DEPLOYMENTS.md` (asset table) | Rooq |
| Deploy and bootstrap scripts | `contracts/script/{Deploy,Bootstrap}.s.sol`, `scripts/deploy-testnet.sh` | `scripts/local-up.sh`; testnet dry run `DEPLOY_ENV=testnet forge script script/Deploy.s.sol --rpc-url rh_testnet` | TESTED LOCAL | Testnet dry run passes against live chain state (43.9M gas, ~0.00088 ETH) | `docs/evidence/03-testnet-deploy-dryrun.txt` | Rooq |
| Testnet deployment and source verification | `scripts/deploy-testnet.sh`, `scripts/verify-testnet.sh` | as listed | BLOCKED | Needs a funded deployer key, testnet USDG and Stock Tokens for seeding | none yet | Founder funds key, then Rooq |
| Maker quote service (delegated hot key, capacity guard with per-quote reservations, per-client rate limit) | `apps/maker/src/quote-server.ts` | used by walkthrough and UI E2E | TESTED LOCAL | Holds only the quote-signing key; cannot move funds. Set `TRUST_PROXY=1` only behind exactly one reverse proxy | walkthrough + `docs/evidence/playwright-report.json` | Rooq |
| Keeper (liquidate, close-only trigger) | `apps/maker/src/keeper.ts` | `ROOQ_ENV=local KEEPER_PRIVATE_KEY=... bun run apps/maker/src/keeper.ts` | IN PROGRESS | Typechecks; scans logs in 5,000-block windows for public RPC limits; liquidation and close-only paths were exercised by the walkthrough, not yet by a long keeper run | walkthrough T08, T12 | Rooq |
| Indexer (reorg-safe, replay, reconciliation) | `apps/indexer` | `cd apps/indexer && bun test && bun run src/reorg-drill.ts && bun run src/restart-drill.ts` | TESTED LOCAL | 49 unit tests; tokens with reverting or over-18 decimals are skipped instead of halting the indexer. Reorg drill: depth-5 reorg detected at ancestor 157, orphaned rows non-canonical, derived tables equal a fresh replay, 133 reconciliation checks, 0 mismatches. Restart drill after SIGKILL: no gaps, no duplicates, 289 of 289 logs. Startup rebuilds derived tables from raw events (slow on long histories) | `docs/evidence/indexer-reorg-local.json`, `indexer-restart-local.json` | Rooq |
| REST and SSE API | `apps/api` | `cd apps/api && bun test` | TESTED LOCAL | 54 unit tests; every route answered against the live local stack; with the database down, chain routes keep working and history routes return 503 INDEXER_BEHIND; vault events and tx status are not yet in the SSE stream | `apps/api/README.md` | Rooq |
| Web app: shell, markets, trade (spot and perps), swap, portfolio, position, activity, settings, status, docs, learn, developers | `apps/web` | `pnpm --filter @rooq/web exec tsc --noEmit`; `cd e2e && npx playwright test --project=desktop` | TESTED LOCAL | Chart and activity need the indexer API; the app says so instead of inventing data | `docs/screenshots/`, `docs/evidence/playwright-report.json` | Rooq |
| Web app: create market (C01 to C07), liquidity (LQ01, LQ02), maker desk (MK01, MK02), asset overview (M02) | `apps/web/app/app/{create,liquidity,makers,assets}` | tsc as above; create flow driven end to end locally | TESTED LOCAL | Perps branch of the create flow needs an approved feed (admin) to run end to end | screenshots | Rooq |
| Accessibility (WCAG 2.2 AA axe, keyboard) | `e2e/ui/pages.a11y.spec.ts` | `cd e2e && npx playwright test ui/pages.a11y.spec.ts` | TESTED LOCAL | Screen-reader pass with VoiceOver not done | 29 passing checks | Rooq |
| Stylus (Rust onchain) | none | n/a | BLOCKED | ArbWasm precompile answers `stylusVersion() = 3` on testnet, but no canary was deployed; Solidity is authoritative | `docs/ARCHITECTURE_ADRS.md` ADR-004 | Rooq |
| Mainnet | none | n/a | NOT STARTED | Requires audit, quant review, legal, oracle redundancy | `docs/known-risks.md` | Founder |

## V1 gates (01-PRODUCT/V1_SCOPE_AND_GATES.md)

| Gate | Local evidence (anvil, chain 31337) | Testnet |
|---|---|---|
| T01 wallet connects, wrong chain rejected | UI E2E connects; `useTxRunner` refuses writes on a chain id mismatch; walkthrough verifies chain id | BLOCKED (no deployment) |
| T02 collateral into our vault | walkthrough: approve exact, deposit, vault balance; UI E2E deposit (two confirmed tx) | BLOCKED |
| T03 spot pool, swaps, LP shares | walkthrough: swap with k non-decreasing, add and remove LP; 16 spot tests | BLOCKED |
| T04 2x long backed by maker quote | walkthrough `open 2x long via maker quote`; UI E2E open and close | BLOCKED |
| T05 2x short | walkthrough `open 2x short via maker quote` | BLOCKED |
| T06 reduce, close, withdraw | walkthrough reduce half, close, withdraw all free | BLOCKED |
| T07 funding without new assets | walkthrough: taker paid 396000 = maker received 396000; T-005 tests | BLOCKED |
| T08 third-party liquidation | walkthrough: healthy liquidation rejected (`NotLiquidatable`), then liquidated after a +16% TEST oracle move | BLOCKED |
| T09 preflight eligible and blocked | five fixture markets activated through `activatePerps`; mMEME `activatePerps` reverted onchain, perps stayed NONE | BLOCKED |
| T10 mobile and desktop with receipts | screenshots at 320, 390, 768, 1440, 1920, light and dark; receipt dialog | BLOCKED |
| T11 indexer reconstructs and handles reorg | reorg drill (depth 5, derived tables equal a fresh replay, 0 reconciliation mismatches) and SIGKILL restart drill (289 of 289 logs, no gaps or duplicates) | BLOCKED |
| T12 stale oracle forces close-only | walkthrough: feed stale after 3,601 s, permissionless `triggerCloseOnly`, mAMZN CLOSE_ONLY | BLOCKED |

Conservation held after every walkthrough step: `totalLedger == collateral.balanceOf(vault)` (55,763,068,000 units at the end).

## Adversarial review, 2026-11-07

A multi-agent review produced 61 candidate findings; it stopped at a usage limit before every candidate was verified, so each one was checked by hand against the code before changing anything.

Fixed with a regression test first (`contracts/test/ReviewFindings.t.sol`, 6 tests written before the fixes; against the old contracts they did not compile because the new errors and functions did not exist, `docs/evidence/04-review-tests-first.txt`):
stale-price partial reduce at an off-market maker price (critical), guardian close-only bypassable through preflight, registry admin able to grant itself the preflight and clearing-house roles (only the direct grant was closed on 2026-11-07; the two-step path through `LOCKED_ROLE` stayed open until W0 on 2026-11-08, see below), live feed id overwritable, funding shortfall drawn from insurance and bond, unbounded funding window after a long gap, reduce fee failing when free balance is empty. Oracle price scaling now fails closed on overflow.

Fixed offchain: web market reads survive one broken market and cover every registry market (portfolio, LP, maker desk, pools); quotes are checked client-side for taker, market, size, hash and signature; the fill uses the size the maker signed; margin for an increase counts the existing position's equity; "1,5" is rejected instead of read as 15; a missing receipt shows "Submitted, but no receipt" instead of hanging; paused pools block the spot ticket; unknown marks show as unknown, not 0; capacity is capped by OI headroom. Indexer skips hostile tokens. Quote service rate-limits per client address (not a spoofable header plus taker) with pruning, and reserves capacity for outstanding quotes. Keeper scans logs in windows. Relay rereads split multipliers every 5 minutes. `scripts/verify-testnet.sh` now passes the compilation profile per contract; without it every verification would have failed.

Documented, not changed: market squatting and the SpotFactory's missing token allowlist (`docs/known-risks.md`), shared quote nonce space per maker (low), preflight tier snapshot timing (low), PerpLens health ignoring pending funding accrual between touches (low).

After the fixes the local stack was redeployed from scratch (2026-11-07): 105 Foundry tests, 10 Rust, 14 SDK, 49 indexer, 54 API, 43-step onchain walkthrough (conservation exact), 30 Playwright checks, all passing.

## Blockers (need the founder or a third party)

1. Funded deployer key for chain 46630. Key created 2026-11-08, address `0xc1207E46F4F5322033685131a0E2640f2D3324da`, held in the macOS Keychain as `rooq-testnet-46630-deployer`; funded by the founder with 0.04 test ETH. Still needed for the full deploy: testnet USDG and the five Stock Tokens for seeding. The core deploy simulates at ~0.00088 ETH; seeding five markets needs testnet USDG (`0x7E955252E15c84f5768B83c41a71F9eba181802F`, Paxos-listed) and the five Stock Tokens. The Robinhood faucet sits behind a bot check, so it has to be used in a browser.
2. Chainlink price feeds on Robinhood Chain testnet: no testnet feed addresses are published (docs.chain.link pages for this network return 404). Testnet perps use the labelled TEST relay until real feeds are verified.
3. Independent audit, quantitative risk review and legal review before any real-money use.

## Private V1 (PRIVATE_V1_ADDENDUM rev 1.0)

The addendum makes a private release the V1 target. Everything above this section is the transparent reference
implementation: it isn't private and meets no PV gate on its own. Per-requirement mapping is in
`docs/privacy/GAP_MAP.md`, and `docs/privacy/PROGRESS_LOG.md` tracks the launch work. Nothing private is deployed anywhere yet.

Launch status, 2026-11-09:

| Area | State | Evidence and honest gaps |
|---|---|---|
| Local end to end, real proofs | Works | Perps 109 steps (`docs/privacy/evidence/w2-offline-liquidation-local.json`), spot 24 (`spot-flow-local.json`), shielded 17 (`w1-shielded-flow-local.json`), services 37 (`services-local.json`). Browser flows pass on the local stack. Worker takeover covers spot, perps rely on forced exit |
| Testnet deploy script (`scripts/deploy-private-testnet.sh`) | Simulates against live 46630, not deployed | Five markets, TSLA, AMZN, PLTR, NFLX, AMD, one feed each, tier B of `config/risk-testnet.json` (2x, IMR 0.5, MMR 0.35), checked against `globalBounds` in the script. Start prices are fetched at deploy time. Broadcast never run. See blockers 7 |
| TEST price relay (`apps/private-services/src/services/price-relay.ts`) | Tested on a local fork, not run on testnet | Single-operator relay of `api.robinhood.com/rhj/prices`, labelled as such in the app and in its health output. Fail-closed on a halted, unreachable or old source. Feed heartbeat is 7 days, so a stopped relay leaves prices usable for up to a week. Evidence `docs/privacy/evidence/vps-launcher-linux.txt` |
| Linux launcher (`infra/vps/`, `docs/privacy/VPS_RUNBOOK.md`) | Tested in a Linux container, no real VPS yet | systemd units, per-service root-only env files, Caddy HTTPS. Tested on arm64 Debian against an anvil fork of 46630. x86-64 and a real VPS not tested. Evidence `docs/privacy/evidence/vps-launcher-linux.txt` |
| Audit and review | Not done | Independent audit, quantitative risk review and legal review are still outstanding. Do not use with real money |
| Risk workers | Testnet gap | On one VPS they share a machine, which doesn't meet LIQ-04's separate failure domains. The runbook covers moving one to a second host |

| Package | Deliverable | Status | Evidence | Blocker |
|---|---|---|---|---|
| W0 baseline and model | Source inventory, gap map, ADR-P01 (threat/disclosure), ADR-P09 (funding and loss), ADR-P10 (governance, role graph); section 15 concerns reproduced and fixed | IN PROGRESS | `docs/privacy/`, `contracts/test/W0SourceConcerns.t.sol`, `docs/privacy/evidence/w0-*.txt` | None. F1 and F2 decided in `docs/privacy/DECISION_LOG.md` |
| W1 crypto/custody foundation | ADR-P02 state schema, ADR-P03 stack benchmark, shielded custody, verifier on 46630 | IN PROGRESS | ADR-P03 decided on measurements (Noir + Barretenberg UltraHonk). First private slice TESTED LOCAL: `zk/circuits/{append,spend}`, `contracts/src/privacy/ShieldedPool.sol` with generated verifiers, `packages/private-sdk`. `e2e/private/shielded-flow.ts`: 16 steps with real proofs on anvil (shield, permissionless queue processing, private transfer with no public asset/amount/addresses, scan, relayed unshield, replay/redirect/fee-bump/unknown-root/non-canonical-nullifier/cross-deployment rejected by the named check, restore from seed, custody = unspent notes) in `docs/privacy/evidence/w1-shielded-flow-local.json`; 13 pool unit tests; 11 SDK tests against the compiled circuits | PV-02 passed on 46630 for the benchmark verifier. Slice covers FREE notes only; no perps, spot, maker, risk or recovery services yet |
| W2 recovery and risk enforcement | Scoped risk data, offline liquidation, encrypted recovery, forced processing | IN PROGRESS | Offline liquidation prototype TESTED LOCAL (ADR-P05): `zk/circuits/{lock,open_pair,liquidate,release}`, `contracts/src/privacy/PrivatePairs.sol`, `e2e/private/offline-liquidation.ts`, 80 steps with real proofs on anvil in `docs/privacy/evidence/w2-offline-liquidation-local.json`, including one-time payout addresses, epoch funding and netting, taker close, forced exit, dead-oracle settlement, fees, open interest limits, margin changes, partial reduce, keyless funding, private insurance with pro-rata claims and the wind-down sweep; 28 `PrivatePairs` unit tests; 1,100 settlement vectors from `crates/risk-kernel/src/private_pair.rs` agree with the SDK and circuits; circuit and SDK math checked against risk-kernel vectors in `packages/private-sdk/test/risk-differential.test.ts` | Markets are fixed at deployment, so permissionless market creation, creator bonds and the bond stage of the waterfall are not on the private system yet. Key rotation, worker services and delay budget not started. Decisions in `docs/privacy/DECISION_LOG.md` |
| W3A private perps | Full proven lifecycle | NOT STARTED | | W1, W2 |
| W3B private spot/LP | Full proven lifecycle | IN PROGRESS | `contracts/src/privacy/PrivateSpot.sol`, `zk/circuits/{swap,lp_add,lp_set,lp_remove}`, `packages/private-sdk/src/spot.ts`. `e2e/private/spot-flow.ts` passes 24 steps with real proofs on local anvil: seed, swap, two-hop route, operator attacks refused, expiry refund, LP add and remove, restore from seed, custody per token, in `docs/privacy/evidence/spot-flow-local.json` | Not yet run by a live service or reachable from the app |
| W4 product integration | 37 surfaces, private API/indexer/receipts | IN PROGRESS | UI redesign per `docs/UX_AUDIT_AND_REDESIGN_PROPOSAL.md` applied to `apps/web` against the transparent reference build: typecheck and build pass, 0 lint errors, route sweep at 320 and 1440 px clean, perps flow passes on local anvil. Private backend not connected; private surfaces are labelled not yet available | W1 to W3. Screen reader, real-device, 200% zoom, performance and reorg checks not run. Creator flow (C03 to C07), swap, LP and maker transactions not exercised after the redesign |
| W5 operational hardening | Drills, envelopes, leakage checks | NOT STARTED | | W4 |
| W6 testnet candidate | Verified deployment, walkthrough, PV-01..30 | NOT STARTED | | Funded key, W5 |
| W7 audit handoff | Frozen package | NOT STARTED | | W6 |

W0 fixes to the reference implementation (2026-11-08):

- `MarketRegistry`: `LOCKED_ROLE` now administers itself. Before, the default admin could grant itself
  `LOCKED_ROLE` and then hand `PREFLIGHT_ROLE` to any address (exploit test passed on the old code). The
  2026-11-07 claim that these roles could never be granted after `wire()` was wrong.
- `ClearingHouse.FundingSettled` now carries `takerOwed` and `takerPaid`. It used to emit only the owed amount,
  and the indexer added that to `fundingPaid`, so receipts overstated funding when the payer was short. Indexer
  migration 3 adds `taker_owed`; reducer version 2; activity copy states written-off amounts. Shortfall is
  written off by decision (ADR-P09 D1); the old comment implying recovery at close was corrected.
- Results: `forge test` 108 passed; indexer 50; API 54; workspace typecheck clean.

Private V1 blockers:

4. Resolved 2026-11-08: ZK toolchains installed by the founder (nargo 1.0.0, bb 5.3.0, RISC Zero 3.0.6).
5. Resolved 2026-11-08: PV-02 passed on 46630. The benchmark `perp_open` verifier is at `0x665736d2b8be0AD287534244c49Fa36a5dFaA5Da`; a genuine proof returned true and a flipped proof byte, flipped input and other-circuit proof all reverted (`docs/privacy/evidence/pv02-46630.txt`). This covers the benchmark verifier. Sourcify shows a match for the verifier and its two libraries; Blockscout refused the libraries with "Unable to verify" (undiagnosed). Etherscan does not list chain 46630. The production circuit verifiers are not deployed.
7. The private deployment has not been broadcast. `scripts/deploy-private-testnet.sh` simulates cleanly against 46630 and `--broadcast` deploys and verifies on Sourcify; broadcast and verify have not been run for this candidate. Before broadcast: fund the deployer and relay key, and confirm the key and domain decisions in `docs/privacy/VPS_RUNBOOK.md`.
6. Resolved 2026-11-08: founder decisions delegated to the implementing agent and recorded in `docs/privacy/DECISION_LOG.md`.
