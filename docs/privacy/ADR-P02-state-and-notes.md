# ADR-P02: Canonical state, records, tree and nullifiers

Status: DRAFT (W1); FREE-record subset IMPLEMENTED and TESTED LOCAL (`contracts/src/privacy/ShieldedPool.sol`,
`zk/circuits`, `packages/private-sdk`, `e2e/private/shielded-flow.ts`). Assumes the ADR-P03 recommendation (Noir + Barretenberg UltraHonk, BN254, Poseidon2,
Grumpkin encryption). Closes when the W1 custody contracts and record circuits implement this schema and the
PV-03/PV-04 negative suites pass. Addendum refs: STATE-01..07, FUNDS-01..05, REC-01, DEPLOY-03.

## 1. Record kinds (STATE-01)

Every economic claim is a record committed into one append-only tree. Nothing in PostgreSQL authorizes value.

| Kind | Holds | Consumed by | Nullifier |
|---|---|---|---|
| `FREE` | Spendable asset amount for an owner | Owner (spend, trade, unshield, LP add, maker backing deposit) | Owner: `H(T_NF, nk, cm)` |
| `PAIR` | One isolated taker/maker pair: market, signed size, entry, both margins, funding snapshot, taker owner, maker owner | Owner close/reduce/margin change, forced funding/liquidation/settlement, migration | Shared: `H(T_NF_REC, cm, rec_nonce)` |
| `MAKER_BACKING` | Maker's committed backing for a market | Maker (quote fill, release), forced settlement | Shared |
| `LP_CLAIM` | LP shares of a pool | Owner remove, frozen settlement | Owner |
| `POOL` | Pool reserves and share supply (one live record per pool) | Pool transitions in a batch (serialized) | Shared |
| `MARKET` | Funding index, OI long/short, insurance, unpaid funding, bad debt per market (one live record per market) | Batch transitions touching the market | Shared |
| `BOND` | Creator bond per market | Creator withdraw, waterfall | Shared |
| `FEE` | Accrued protocol/LP fees per market | Fee claim | Shared |
| `EXIT` | Pending withdrawal claim (asset, amount, recipient, request id) | Custody release on finalization | Shared |
| `QUOTE_USE` | Consumption of a maker quote nonce (fill amount) | n/a (marker only) | `H(T_QUOTE, maker, nonce)` plus fill accounting |

`MARKET` and `POOL` are singleton chains: each transition consumes the previous version and emits the next, so
two batches cannot both extend the same version (STATE-03, STATE-06).

## 2. Commitment format (STATE-02)

`cm = Poseidon2(T_KIND, deployment_id, version, domain, asset, fields..., inner)` with
`inner = Poseidon2(T_INNER, owner, rho, blind)`. A depositor publishes only `inner`, so the append circuit can
build the commitment from the public asset and amount without learning the owner.

- `deployment_id = (chainid << 160) | pool address` binds chain 46630 and the exact deployment (DEPLOY-03). A record from another deployment
  cannot verify against this tree.
- `version` is the record schema version; circuits accept only their version.
- `domain` is the accounting domain (FREE, per-market perp, per-pool spot, insurance, bond, fee). Release logic
  checks it (STATE-04).
- `rho` is unique per record (derived from the consumed inputs' nullifiers and the output index, as in Zcash
  Orchard) so two outputs never share a commitment; `blind` is 254-bit hiding randomness.
- Field ranges: amounts < 2^100 token units (USDG 6 decimals gives far more than total supply); prices and sizes
  < 2^100 at 1e18 scale; products checked below 2^248 before division (benchmark `ceil_div` pattern).

## 3. Tree

- Depth 32 incremental Poseidon2 tree, leaves appended in order. Capacity 4.29B records.
- Appends happen inside proofs: a batch proof shows `old_root, old_count -> new_root, new_count` for the leaves it
  inserts. The contract stores `root` and `count` and accepts a batch only if its `old_root/old_count` equal the
  stored values (STATE-05). This avoids ~32 Poseidon2 hashes per insert in Solidity.
- Spends prove membership against any root in a bounded history window (last 64 roots) so client proofs survive
  a few concurrent batches (STATE-06). Spent status is checked against current state through the nullifier set.

## 4. Nullifier set

- On-chain `mapping(bytes32 => bool) spent` in the state registry. Each batch submits its nullifiers; the
  contract reverts if any is already set and sets all of them. Cost ~22.1k gas per new nullifier.
- Alternative measured later: indexed Merkle tree with non-membership proofs (cheaper storage, more proving).
  Not chosen for W1 because on-chain storage is simpler to audit and reorg-safe by construction.

## 5. Consumption identity (STATE-07)

Shared records (PAIR, MAKER_BACKING, POOL, MARKET, BOND, FEE, EXIT) use `H(T_NF_REC, cm, rec_nonce)` where
`rec_nonce` is a random value inside the record plaintext. The owner branch and every forced branch compute the
same value, so an owner close and a forced liquidation of the same pair cannot both be accepted: the second
batch reverts on the spent check. The risk worker learns `rec_nonce` from the risk ciphertext, so it needs no
owner secret (LIQ-01).

FREE and LP_CLAIM use owner nullifiers because only the owner may consume them and no forced branch exists for
free balances (FUNDS-05 exits are owner-initiated).

## 6. Authorization branches

| Branch | Who proves | Authority predicate |
|---|---|---|
| Owner spend | Client wallet | Knowledge of `sk` with `owner = H(T_OWNER, H(T_AUTH, sk), pk_enc)` |
| Maker fill | Coordinator, from maker's signed quote | ECDSA over the in-circuit EIP-712 digest; `address(pk) == maker` in the record owner |
| Forced (funding, liquidation, settlement) | Designated risk worker / coordinator | The record's committed policy plus public market state; beneficiaries fixed by the record; no signature |
| Migration | Owner or forced, per migration policy | As above, against the old deployment's root |

## 7. Ciphertexts (REC-01)

Every output record is encrypted inside the proof to the keys entitled to it, and the ciphertext hash is a
public input, so an operator cannot finalize undecryptable outputs:

- FREE / LP_CLAIM: the owner's `pk_enc`.
- PAIR: taker `pk_enc`, maker `pk_enc`, and each assigned risk worker key `rk_i` (LIQ-02, REC-06).
- Shared singletons (POOL, MARKET): coordinator key plus each risk/recovery key per ADR-P06.

Scheme: Grumpkin ECDH with a fresh ephemeral scalar, Poseidon2 keystream, field-add masking. The benchmark
proves this costs one fixed-base and one variable-base scalar multiplication per recipient. Ciphertexts are
posted in calldata (ADR-P06 decides retention and DA).

## 8. Deposits and withdrawals (FUNDS-01, FUNDS-04)

- Deposit: user calls `shield(token, amount, cm)` on custody. The contract pulls the token, measures the balance
  delta (rejects fee-on-transfer), and appends `(token, amount, cm, depositor)` to a deposit queue with a
  sequence number. A batch consumes a queue prefix and proves each `cm` is a FREE record of exactly `token` and
  `amount`. Credit happens once because queue entries are consumed by sequence.
- Withdrawal: a client proof consumes FREE records and creates an `EXIT` record bound to `(token, amount,
  recipient, fee, request_id)`. When its batch is accepted the contract records `request_id` as finalizable; a
  separate `release(request_id)` transfers tokens once. The `request_id` is single-use across retries, reorgs and
  deployments.

## 9. Custody invariant (PV-03)

For each token: `custody.balanceOf(token) == sum(unspent records of that token across all domains) + queued
deposits not yet consumed - released-but-unbatched (always 0)`. Proofs enforce per-transition conservation; the
invariant suite reconciles it over random sequences using the reference model (`crates/risk-kernel` extended),
which does not call the circuits.

## Implemented so far (FREE subset)

- `append` circuit (44,112 gates): inserts up to 8 queue entries; deposits are rebuilt from public asset/amount
  and the depositor's `inner`; spend outputs are inserted as given. No secrets, so queue processing is
  permissionless. Measured about 3.95M gas per batch on anvil.
- `spend` circuit (13,752 gates): two FREE inputs (zero-value dummies allowed), two outputs with derived `rho`,
  in-proof encryption to each recipient, optional withdrawal and relayer fee. The asset is public only when value
  leaves the pool. Measured about 3.85M gas.
- Deposit openings derive from the wallet seed (`depositOpening(seed, k)`), so a restored wallet finds its
  deposits from public `Shielded` events without any ciphertext. Restore of deposits, received notes and spent
  status from seed is exercised end to end.
- The contract rejects non-canonical field encodings of nullifiers/commitments, so one note cannot occupy two
  nullifier slots.

## Implemented so far (LOCK and PAIR prototype)

`LOCK` is a record kind not in the section 1 table: escrowed value with committed terms and an expiry. `PAIR` carries
its funding snapshot and pays out to one-time addresses. `MARKET` is implemented as a head commitment on the contract,
not a tree leaf: open-interest changes queue up and `funding_epoch` folds them, replacing the section 1 singleton chain
that every trade would have had to extend. Both use shared nullifiers with a privately salted `rec_nonce`. See ADR-P05.

## Open items before freeze

- Membership root window size vs. batch frequency (measure in W1).
- `QUOTE_USE` partial-fill accounting: either a record chain per quote or a nullifier per (quote, fill index).
- Fixed-shape batches or padding to limit size/timing leakage (ADR-P01 field table, last row).
- On-curve checks for all witness-supplied Grumpkin keys (the benchmark found the stdlib curve ops do not check
  witness points; `assert_on_curve` was added).
