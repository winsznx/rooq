# Test plan and results

Maps 03-ENGINEERING/TEST_PLAN_INVARIANTS.md to real tests. Only results from runs on 2026-11-07 are listed.

## Commands
| Suite | Command | Result |
|---|---|---|
| Contracts (unit, fuzz, invariant, parity) | `cd contracts && forge test` | 105 passed, 0 failed (`docs/evidence/01-forge-test.txt`), including 6 review regressions in `ReviewFindings.t.sol` |
| Rust risk kernel | `cargo test --workspace` | 10 passed (`docs/evidence/02-cargo-test.txt`) |
| SDK (TypeScript parity, formatting) | `pnpm --filter @rooq/sdk test` | 14 passed |
| Indexer | `cd apps/indexer && bun test` | 49 passed |
| API | `cd apps/api && bun test` | 54 passed |
| Type checks | `pnpm --filter @rooq/{sdk,config,maker,e2e,web} exec tsc --noEmit` | clean |
| Onchain walkthrough | `ROOQ_ENV=local ... bun run e2e/onchain/walkthrough.ts` | 43 steps (`docs/evidence/walkthrough-local.json`) |
| Browser flow | `cd e2e && npx playwright test ui/perps.flow.spec.ts` | 1 passed (redeployed contracts, 2026-11-07) |
| Accessibility | `cd e2e && npx playwright test ui/pages.a11y.spec.ts` | 29 passed |

## P0 properties
| ID | Property | Test |
|---|---|---|
| T-001 | deposits and withdrawals conserve token units | `MarginVaultTest.test_T001_*`, fuzz, `invariant_ledgerEqualsTokenBalance` |
| T-002 | locked margin never withdraws | `test_T002_*` |
| T-003 | maker and taker exposure sum to zero | `test_T003_*`, `invariant_openInterestMatchesPairs` |
| T-004 | realised PnL debits equal credits | `test_T004_*` |
| T-005 | funding nets to zero | `test_T005_*`, walkthrough T07 |
| T-006 | insurance never below zero; exhaustion records bad debt and forces close-only | `test_T006_*` |
| T-007 | liquidation only when unhealthy under a fresh oracle | `test_T007_*` |
| T-008 | reduce never creates exposure | `test_T008_*` |
| T-009 | expiry and replay fail | `test_T009_*`, cross-chain and cross-contract replay tests |
| T-010 | partial fills cannot exceed the signed size | `test_T010_*`, fuzz |
| T-011 | stale feed blocks risk increases and enables close-only | `test_T011_*`, walkthrough T12 |
| T-012 | creator cannot exceed global bounds | `test_T012_*` |
| T-013 | fees claimed once | `test_T013_*` |
| T-014 | pausing one market leaves another trading | `test_T014_*` |
| T-015 | Rust equals EVM | `RiskParityTest` (1,400 vectors, two lifecycles through the real ClearingHouse) |

## Security cases covered
Fee-on-transfer collateral and pool tokens rejected; reentrant token blocked; tampered quote, wrong taker, wrong chain, wrong ClearingHouse, cancelled nonce, nonce floor, revoked delegated signer; donation does not inflate shares; vault operators cannot be re-wired; unknown tier and out-of-bound parameters rejected; feed for another asset rejected.

## Not yet covered
Upgradeability (no proxies are used); EIP-1271 makers (unsupported); long-running keeper soak; testnet E2E (blocked on deployment); visual regression diff gate; VoiceOver pass.
