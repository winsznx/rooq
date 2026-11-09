# ADR-P10: Governance, verifier versioning, migration, key custody

Status: DRAFT (W0). The legacy role graph below is verified. Private-system governance is a proposal until the
W1 contracts exist. Addendum refs: MARKET-04, MARKET-05, OPS-05, DEPLOY-01..04, PV-28, section 15 concern 2.

## Legacy authority graph (verified 2026-11-08)

| Contract | Authority | Holder on testnet | Can do | Reachability |
|---|---|---|---|---|
| MarketRegistry | `DEFAULT_ADMIN_ROLE` | deployer | `wire` once, `setTier`/`setQuoteAsset` within immutable bounds, `releaseGuardianHold`, grant/revoke `DEFAULT_ADMIN_ROLE` and `GUARDIAN_ROLE` | Self-administered (OpenZeppelin default) |
| MarketRegistry | `GUARDIAN_ROLE` | deployer | Risk-reducing status moves (ACTIVE/CLOSE_ONLY/PAUSED/SETTLEMENT_PENDING/SETTLED), `tightenRisk`; sets `guardianHold` | Admin is `DEFAULT_ADMIN_ROLE`, so the admin can appoint guardians. Guardian cannot return a market to ACTIVE |
| MarketRegistry | `PREFLIGHT_ROLE`, `CLEARING_HOUSE_ROLE` | MarketPreflight, ClearingHouse (set by `wire`) | `activatePerp`, `reportCloseOnly` | Admin is `LOCKED_ROLE`, which now administers itself and has no holder. Before the W0 fix, the default admin could grant itself `LOCKED_ROLE` and then either role to anyone (exploit reproduced, `docs/privacy/evidence/w0-concerns-before-fix.txt`). Now unreachable: `test_defaultAdminCannotReachLockedRole`, `test_adminCannotGrantWiredRoles` |
| OracleAdapter | immutable `admin` | deployer | Register/revoke feeds; cannot repoint an existing feed id | Not transferable |
| MockPriceFeed | `operator` | relay key | Write TEST prices within feed bounds | `transferOperator` by operator |
| MarginVault, MarketBackstop | immutable `_deployer` | deployer | One-time `wire` of operators | Not transferable; no sweep |
| SpotPool | immutable `guardian` (from SpotFactory) | deployer | Pause/unpause pool | Not transferable |
| QuoteVerifier | per-maker signer | each maker | Delegate quote signing | Maker only |

Decided in `DECISION_LOG.md` D-04: no private state may block an exit or liquidation. Background (MARKET-04): the guardian can move CLOSE_ONLY to PAUSED. What PAUSED permits on the legacy
ClearingHouse (closes, margin add, liquidation) has to be checked against "emergency stops must not disable the only
safe exit" before any private-system status machine copies it.

## Private-system governance (proposal for W1)

1. Immutable deployments plus voluntary migration (MARKET-05 allows this). No proxy upgrades.
2. The state registry pins, per accepted root: verifier key hash, circuit/program id, policy version, oracle set
   version, ciphertext format version. A root can only be extended by a proof whose verifier key hash matches the
   pinned set for that deployment. There is no admin function that changes the verifier of an existing deployment.
3. A new circuit version means a new deployment id. Notes and nullifiers are domain-separated by deployment id
   (DEPLOY-03), so nothing from v1 is accepted by v2 except through an explicit migration transition that consumes
   a v1 record (proven against v1 state) and emits a v2 record.
4. Admin powers that remain: list markets/assets within immutable bounds, risk-reducing guardian moves, feed
   approval. None can move custody, alter accepted state, decrypt history, or extend exit deadlines.
5. Role graph is enumerated by a test that walks `getRoleAdmin` for every role constant and asserts the closure
   (PV-28), rather than by documentation.

## Key custody (deployment)

| Key | Purpose | Testnet custody | Must not |
|---|---|---|---|
| Deployer | Deploy, one-time wiring | Founder-funded EOA via env var, never written to disk | Hold ongoing powers it does not need; transfer admin to a separate key after deploy |
| Registry admin | Tiers, quote assets, hold release | Same EOA on testnet (disclosed) | |
| Guardian | Risk-reducing moves | Same EOA on testnet (disclosed) | |
| Oracle operator | TEST prices | Relay hot key | |
| Relayer keys | Gas for proof submission | Per-relayer hot keys | Have any authority beyond paying gas |
| Risk worker keys `rk_i` | Decrypt assigned pairs | One per worker, separate hosts | Be shared between workers (REC-08) |
| Key guardian | Schedules and cancels operator key rotation (D-24) | Same EOA on testnet (disclosed); a multisig before real use | Hold any power over funds, markets or records |

## Deployment record (DEPLOY-04)

Each deployment record pins: solc version and settings per contract (ClearingHouse via-IR), proving stack versions,
circuit/program hashes, verifying key hashes, generated ABI/SDK hash, config hash, and the role manifest above.
`scripts/verify-testnet.sh` already selects the per-contract compilation profile; the private contracts extend it.
