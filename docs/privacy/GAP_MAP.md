# Private V1 gap map (W0)

Source of truth: the private V1 addendum in Rooq's product spec (rev 1.0, 8 Nov 2026), which is kept outside this repository.
Inspected on 2026-11-08 against the working tree (no commits exist yet in this repository).

The existing code is a transparent reference implementation: every balance, pair, fill, quote, LP share and
funding payment is address-indexed public state or a public event. None of it is private. This file maps each
addendum requirement to what exists, what has to change, and the work package that owns it.

Status vocabulary: NOT STARTED, IN PROGRESS, TESTED LOCAL, DEPLOYED TESTNET, VERIFIED TESTNET, BLOCKED.

## Starting-point inventory (addendum section 15)

| Component | What it does today | Public leakage today | Private V1 treatment | Package |
|---|---|---|---|---|
| `contracts/src/perps/MarginVault.sol` | Address-keyed ledger in domains (FREE, per-market), `move` by wired operators | `Deposited`, `Withdrawn`, `Moved(fromDomain, from, toDomain, to, amount)` on every margin movement; `balanceOf(domain, account)` readable by anyone | Replaced by shielded custody (`contracts/src/privacy/`) holding real tokens per asset/domain, releasing only against proven withdrawals. Legacy vault stays for exit only | W1 |
| `contracts/src/perps/ClearingHouse.sol` | Matched pairs keyed by `marketId + taker`, EIP-712 quotes, funding, liquidation, settle at mark | `TradeExecuted`, `PositionChanged`, `FundingSettled`, `Liquidated`, `MarginChanged`, `BackingChanged` carry addresses, sizes, prices; `getPair` readable | Economics ported into proven transitions over committed pair records. No address-keyed storage on the private path | W3A |
| `contracts/src/perps/QuoteVerifier.sol` | EIP-712 domain, nonce bitmap, partial fills, delegated signer | `QuoteConsumed(quoteHash, maker, nonce, filled)` links maker fills | Quote fields, signature and fill become proof witnesses; nonce consumption becomes a committed record; maker identity public only where ADR-P01 permits | W1/W3A |
| `contracts/src/perps/MarketBackstop.sol` | Per-market insurance and creator bond, sequential `coverShortfall` | Insurance and bond movements by address | Insurance/bond as committed domain records; frozen-settlement entitlement algorithm (REC-04) replaces sequential cover | W2/W3A |
| `contracts/src/perps/PerpLens.sol` | Health/liquidation views over public pairs | Any address's health | Removed from the private path; health computed by wallet and risk services from decrypted scoped state | W3A |
| `contracts/src/spot/{SpotPool,SpotRouter,SpotFactory}.sol` | Public constant-product pools, ERC-20 LP shares | `SwapExecuted`, `LiquidityAdded/Removed` with sender/owner/amounts; LP balances | Private pool transitions over committed reserves and shielded LP claims | W3B |
| `contracts/src/market/{MarketRegistry,MarketPreflight}.sol` | Market identity, status machine, preflight | Public by policy (section 2.1 row 1 and creator/admin row) | Kept public; activation adds verifier/data/risk readiness checks (MARKET-02) | W1/W4 |
| `contracts/src/oracle/OracleAdapter.sol` | Fail-closed asset-bound feeds | Public by policy | Must expose authenticated observation contents per epoch so proofs can bind to them (ZK-05) | W1 |
| `apps/maker/src/quote-server.ts` | Signs RFQ quotes, in-memory reservations | `GET /quotes/recent` returns the last 50 quotes with taker and size; reservations lost on restart | Remove `/quotes/recent`; durable reservations; authenticated private quote access | W4 (removal can happen earlier) |
| `apps/api/src/routes.ts` | REST/SSE over indexer + chain | `/account/:wallet` and `/account/:wallet/activity` enumerate any address; `/markets/:id/trades` is an exact tape; quote proxy forwards `x-forwarded-for` client IP to the maker (line ~376) | Authenticated scoped views, aggregate-only market data, no IP forwarding | W4 |
| `apps/maker/src/keeper.ts` | Scans public `PositionChanged` logs, calls `liquidate` | Depends on public positions | Designated risk workers with scoped encrypted state, proof-constrained forced transitions, redundancy | W2 |
| `apps/indexer` | Reorg-safe replay into plaintext account tables | Rebuilds every account's positions and history | Commitment/nullifier/queue/ciphertext indexing; no plaintext account tables | W4 |
| `crates/risk-kernel` | Integer arithmetic reference, pair simulator, parity vectors | n/a | Extended to the full authenticated transition reference used for differential tests against circuits | W3A/W3B |
| `apps/web` | 37 surfaces over public reads | Wallet address drives every private view | Private wallet (keys, notes, proofs), operation state machine, authorized views | W4 |

## Mandatory source concerns (section 15)

| Concern | Reproduction | Disposition | Status |
|---|---|---|---|
| `FundingSettled` emitted `owed`, not the amount moved; comment implied later recovery of the shortfall but only a market total is stored | `contracts/test/W0SourceConcerns.t.sol::test_fundingSettledReportsPaidSeparatelyFromOwed` failed on the unfixed code (`docs/privacy/evidence/w0-concerns-before-fix.txt`). The indexer added the owed amount to `fundingPaid`, overstating receipts | Shortfall is written off (ADR-P09). Event now carries `takerOwed` and `takerPaid`; indexer stores both (migration 3), position `fundingPaid` sums actual payments, activity copy states the written-off amount. `test_fundingShortfallIsWrittenOffAtClose` pins that close does not collect it | TESTED LOCAL |
| `LOCKED_ROLE` admin was `DEFAULT_ADMIN_ROLE`, so the admin could grant itself `LOCKED_ROLE` and then `PREFLIGHT_ROLE`/`CLEARING_HOUSE_ROLE` to anyone | A scratch exploit test granted `PREFLIGHT_ROLE` to an arbitrary address and passed (appended to the same evidence file). The earlier claim "can never be granted after wire()" was false | `_setRoleAdmin(LOCKED_ROLE, LOCKED_ROLE)` in the constructor. `test_defaultAdminCannotReachLockedRole` passes. Full role graph in ADR-P10 | TESTED LOCAL |

After both fixes: `forge test` 108 passed, 0 failed (`docs/privacy/evidence/w0-forge-after-fix.txt`); indexer 50 tests and API 54 tests pass; workspace typecheck clean.

## Requirement map

"Exists" names the reusable part of today's code. Everything in the private column is NOT STARTED unless marked.

| IDs | Exists today | Gap | Package | Status |
|---|---|---|---|---|
| SCOPE-01..05 | Transparent V1 locally complete | Whole private release | all | IN PROGRESS (W0) |
| PRIV-01..06, section 2.1 matrix | Nothing private | Field-level disclosure schema, leakage review, copy | W0 (ADR-P01), W5 (PV-24) | IN PROGRESS: ADR-P01 draft |
| ARCH-01, STATE-01..07 | Financial rules in Solidity and Rust | FREE records, tree, owner nullifiers, deployment binding implemented; shared-record kinds (PAIR, MAKER_BACKING, POOL, MARKET, BOND, FEE, EXIT) not yet | W1 (ADR-P02) | IN PROGRESS |
| ZK-01..06 | ADR-P03 benchmark (`zk/bench`): Noir+bb vs RISC Zero on the same two transitions; Noir+bb recommended | Production circuits, verifier on 46630 | W1 (ADR-P03) | IN PROGRESS; chain step BLOCKED on funded key |
| FUNDS-01..06 | Public deposit/withdraw in MarginVault | Shield, private spend, unshield, restore from seed (TESTED LOCAL for FREE notes, `e2e/private/shielded-flow.ts`); encrypted local key storage, restore ceremony UI, key rotation, reorg/restart drills remain | W1, W2 | IN PROGRESS |
| RFQ-01..06 | EIP-712 quotes, nonce bitmap, partial fills, in-memory reservations | Quote as private witness, acceptance-time deadlines, durable reservations, metadata limits | W1, W3A, W4 (ADR-P04) | NOT STARTED |
| PERP-01..07 | Full paired economics, funding cap, backstop waterfall, bad debt | Proven transitions; funding owed/paid/shortfall decided (ADR-P09) | W3A | IN PROGRESS: ADR-P09 draft |
| LIQ-01..08 | Public keeper, permissionless liquidate | Scoped risk access and forced branch TESTED LOCAL as a prototype (ADR-P05, `e2e/private/offline-liquidation.ts`), funding not yet settled in it; per-lock addresses, redundant worker services, measured delay budget and censorship escape remain | W2 (ADR-P05) | IN PROGRESS |
| SPOT-01..07 | Public constant-product pools and router | Private reserves, LP claims, batch semantics | W3B (ADR-P07) | NOT STARTED |
| MARKET-01..05 | Registry, preflight, guardian hold, bounded tiers | Verifier/data/risk readiness gates; pinned versions | W1, W4 (ADR-P10) | IN PROGRESS: role graph fixed |
| REC-01..09 | Indexer reorg/restart drills (public data) | Ciphertext correctness, DA, forced processing, freeze, entitlement settlement | W2 (ADR-P06, P08) | NOT STARTED, except REC-07 below |
| REC-07 | None: keys were fixed at construction | Rotation, future-access revocation, device loss, compromised service keys | D-24, `docs/privacy/KEY_INCIDENTS.md` | TESTED LOCAL: delayed rotation in `contracts/src/privacy/PrivateMarkets.sol`, tests in `contracts/test/privacy/PrivateMarkets.t.sol`, real-proof steps in `e2e/private/offline-liquidation.ts` and `apps/private-services/test/integration.ts` (old position liquidated with the retired key, lock to a retired key rejected, new lock under new keys, old position migrated forward, retired key required until then). Not done on testnet. Not audited. |
| DATA-01..07 | Public API/indexer/SSE | Private reads, scoped auth, leak removal, logging verification | W4 | NOT STARTED |
| UX-01..07 | 37 surfaces, public reads | Private wallet, operation state machine, receipts, disclosures | W4 | NOT STARTED |
| OPS-01..06 | Local stack scripts, runbook, known risks | Separate proving/risk/DA services, drills, reconciliation | W5 | NOT STARTED |
| DEPLOY-01..04 | Deploy/verify scripts, dry run on 46630 | Versioned private deployment, legacy migration | W6 | BLOCKED on funded deployer key for any chain step |
| PV-01..PV-30 | none | all | W1 to W7 | NOT STARTED |

## Hard external dependencies already known

1. Resolved for PV-02: the founder funded a deployer key on 46630 and the verifier experiment passed (`docs/privacy/evidence/pv02-46630.txt`). Later testnet gates use the same key.
2. ZK toolchains: installed 2026-11-08 (nargo 1.0.0, bb 5.3.0, RISC Zero 3.0.6).
3. Precompile support on 46630: BN254 ecAdd/ecMul/ecPairing and modexp answer correctly (read-only probe). A genuine proof on 46630 still needs the funded key.
