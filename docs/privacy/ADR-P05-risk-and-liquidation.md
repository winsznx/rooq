# ADR-P05: Risk data, forced liquidation and the W2 prototype

Status: DRAFT. Prototype IMPLEMENTED and TESTED LOCAL only (`contracts/src/privacy/PrivatePairs.sol`,
`zk/circuits/{lock,open_pair,liquidate,release,funding_epoch}`, `packages/private-sdk/src/pairs.ts`,
`e2e/private/offline-liquidation.ts`). Not deployed to 46630. Not audited.
Addendum refs: LIQ-01..08, STATE-07, REC-01, REC-02, PERP-01, PERP-07.

## Decision

A position is a shared PAIR record. Every authority over it is a predicate in a circuit, and none of the forced
branches takes an owner key.

| Step | Prover | Authority |
|---|---|---|
| `lock` | Owner's wallet | Spending key over FREE notes; commits trade terms and an expiry |
| `open_pair` | Coordinator | Both locks' committed terms, the contract's oracle mark and market IMR |
| `liquidate` | Any holder of a risk key | Pair is in the tree, unspent, and below maintenance at the contract's mark |
| `release` | Anyone holding the lock plaintext | Lock expired; the only beneficiary is its committed owner |
| `funding_epoch` | Any holder of a coordinator or risk key | Folds pending open-interest changes; the contract fixes which ones, the time and the mark |

The contract, never the prover, supplies the mark (`getFreshPrice`), risk fractions, penalty, scale, insurance
balance, coordinator key and both risk keys. A proof built on any other value fails in the verifier.

Liquidation mirrors `ClearingHouse.liquidate`: taker checked first, then maker; close the whole pair at the mark;
PnL transfer capped by the loser's margin; shortfall drawn from market insurance, remainder recorded as bad debt;
penalty capped by what the liquidated side has left, half to the liquidator as a shielded note, half to insurance.
Funding settles first against the contract's index, and unpaid funding counts against the payer's health and its own
PnL gain (`DECISION_LOG.md` D-03, D-08). Funding never draws on insurance.

The pair is encrypted inside `open_pair` to taker, maker and both risk keys, so a valid position with unreadable
risk data cannot exist (LIQ-04, REC-01). Shared nullifier `H(T_NF_REC, cm, rec_nonce)` makes every branch consume
the same identity (STATE-07). `rec_nonce` includes a private salt: without it, anyone could compute a record's
nullifier from public data and link its creation to its consumption.

Why locks rather than two owner proofs: one proof cannot hold two owners' keys, and recursive composition costs
about 1.47M gates per pair (ADR-P03). A lock is the owner's one-time, bounded authorization. The coordinator can
fill it only inside its terms or leave it to expire.

## Evidence (local anvil, real UltraHonk proofs)

`docs/privacy/evidence/w2-offline-liquidation-local.json`. Rejections are asserted by named constraint or error.

- Opened four pairs: long, short, one where the maker is the unhealthy side, and one where funding exceeds margin.
- Pairs hold one-time addresses only, not either wallet's main key (D-06).
- A winning payer's gain is netted against unpaid funding, checked against an independent computation (D-03).
- Both workers decrypt independently from chain data. A non-risk key finds nothing.
- Worker A liquidates with neither trader involved. Owners recover forced outputs from seed and chain.
- Worker B's competing proof fails on the shared nullifier.
- Refused: changed lock size, fill past limit, maker below IM, coordinator-chosen risk key, garbled risk ciphertext,
  healthy liquidation, earlier price, other live market at the same price, changed reward note, value moved between
  insurance and reward, stale insurance claim, expired match, early release, future `asOf`, claimed open interest
  that does not match the head, changed funding index.
- Insurance draw then bad debt exercised. Custody equals live notes, open locks and insurance.
- Circuit and SDK math agree with `crates/risk-kernel` vectors (`risk-differential.test.ts`): 200 margin, 200 fee,
  300 PnL cases including shorts and losses.

Review found one soundness bug before first run: `reward` was not range-checked, so an odd penalty admitted
`penalty / 2 mod p`, a huge value the contract would have paid out. Fixed with `assert_amount(reward)`.
The first full funding run found a second: `_liquidateInputs` allocated one slot too few and panicked. A unit test had
passed through that panic because it accepted any revert, so those tests now fail on a panic.

Measured: `lock` 4.01M gas, `openPair` 4.24M, `liquidate` 4.09M, `release` 3.75M, `advanceFunding` 3.78M. Proving 0.23 to 0.69 s per proof with bb.js on
4 threads on the founder's Mac. Gates: lock 17,477; open_pair 28,060; liquidate 19,517; funding_epoch 15,244.

## Not implemented (blocks the W2 and W3A gates)

Funding, fees, open interest limits, margin changes and partial reduce are now built (`DECISION_LOG.md` D-13 to D-16).
`crates/risk-kernel/src/private_pair.rs` models them; 900 vectors are checked against the SDK and circuits.

- Bond and haircut stages of the waterfall (PERP-07).
- Risk key rotation: keys are immutable per deployment (REC-07).
- Delay budget and worker services (LIQ-04, LIQ-06). The workers here are functions in a test script.

## Known privacy costs

1. `PairLiquidated` and `PairOpened` publish the market and that the event happened. The record kind is public too.
2. The funding index publishes the long/short skew each epoch. In a market with one open position it reveals that
   position's direction (D-08).
3. The epoch's claim ratio goes below 1 only when a market cannot cover its shortfalls, which reveals that it is short.
4. The coordinator sees every lock's terms, against one-time addresses.

## Limits to know

- Restore cost grows with ciphertexts times the wallet's lock addresses (D-06). The REC-09 bound is not measured yet.
- Output notes above 2^100 units would be unspendable. Only reachable with a token supply beyond that.
- Execution depends on the testnet oracle relay, a disclosed single-operator dependency.
