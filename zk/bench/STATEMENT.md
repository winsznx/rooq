# ADR-P03 benchmark statements

Two representative Rooq transitions, implemented once per candidate stack with the same checks. These are
benchmark programs for choosing a proving stack. They are not the frozen circuits: ADR-P02 fixes the real
schema after the stack is chosen.

Each stack uses the hash and curve that are cheap for it, because that is what a production build would do:

| Primitive | Noir / Barretenberg | RISC Zero |
|---|---|---|
| Hash `H` (commitments, tree, nullifiers, keystream) | Poseidon2 over BN254 (`poseidon` v0.4.0 sponge) | SHA-256 (accelerated) |
| Encryption curve | Grumpkin (embedded curve) | secp256k1 (accelerated `k256`) |
| Quote signature | secp256k1 ECDSA, keccak-256 EIP-712 digest | same |

Common constants: tree depth 32, deployment id and domain tags as the first hash input.

## Shared objects

- `auth = H(T_AUTH, sk)`; `nk = H(T_NK, sk)`.
- Owner tag `owner = H(T_OWNER, auth, pk_enc)`, where `pk_enc` is the owner's encryption public key. A
  ciphertext encrypted to `pk_enc` is therefore bound to the note owner (REC-01).
- Note commitment `cm = H(T_NOTE, deployment, domain, asset, value, owner, rho, blind)`.
- Owner-spent nullifier `nf = H(T_NF, nk, cm)`.
- Shared record (maker backing, pair) nullifier `nf = H(T_NF_REC, cm, rec_nonce)`. It needs no owner secret, so
  owner and forced branches produce the same consumption identity (STATE-07).
- Merkle node `H(T_NODE, left, right)`; leaf is `cm`.
- Encryption to `pk`: ephemeral scalar `e`, `E = e*G`, `S = e*pk`, keystream `k_i = H(T_ENC, S.x, i)`,
  `ct_i = pt_i + k_i` (field add in Noir, XOR of 32-byte words in RISC Zero). Public input is
  `H(T_CT, E, ct_0..ct_n)`. The proof shows the ciphertext encrypts exactly the committed output to that key.

## Op A: private transfer (2 in, 2 out)

Private: `sk`, `pk_enc` of the spender, two input notes with membership paths, two output notes
(value, owner, rho, blind), recipients' `pk_enc`, ephemeral scalars.

Public: `root, nf_0, nf_1, cm_out_0, cm_out_1, ct_hash_0, ct_hash_1, deployment, asset, fee`.

Checks: both inputs are in the tree under `root`, owned by `owner(sk, pk_enc)`; nullifiers correct and distinct;
same asset and domain; values < 2^100; `in_0 + in_1 = out_0 + out_1 + fee`; each output commitment and each
ciphertext matches (output owner tag is rebuilt from the recipient's `auth` and `pk_enc`).

## Op B: private perp open

Private: taker `sk`, `pk_enc`, taker free note (collateral) + path; maker backing record + path + `rec_nonce`;
quote fields; maker signature and public key; oracle price; taker margin; new pair record nonce and blinds;
ephemeral scalars.

Public: `root, nf_taker, nf_maker, quote_id, cm_pair, cm_taker_change, cm_maker_change, cm_fee,
ct_pair_risk, ct_pair_owner, oracle_cm, batch_time, domain_separator, deployment, policy_version, risk_pk,
market, imr_bps, fee_bps, max_dev_bps`.

Checks:

1. Membership of both inputs; taker nullifier from `nk`; maker nullifier from `(cm, rec_nonce)`.
2. EIP-712 digest computed in-circuit with keccak-256 from every quote field (chain-bound domain separator,
   market, maker, taker binding, signed size, price, min fill, nonce, deadline, policy version). ECDSA verifies
   against the maker key; `address(keccak(pk)) == quote.maker`; the maker record's owner is that address.
3. `quote.taker == H(T_TAKER, taker owner)`; `quote.deadline >= batch_time`; `quote.policy == policy_version`;
   `quote.market == market`. `quote_id = H(T_QUOTE, maker, nonce)` is published for replay protection.
4. Oracle: `oracle_cm = H(T_ORACLE, market, price, epoch)`; `|quote.price - oracle| * 10000 <= max_dev * oracle`.
5. Economics (USDG 6 decimals, price and size 18 decimals): `notional = ceil(|size| * price / 1e30)`;
   `fee = ceil(notional * fee_bps / 1e4)`; taker margin `* 1e4 >= notional * imr_bps`; maker margin
   `* 1e4 >= notional * imr_bps`; `taker_in = taker_margin + fee + taker_change`;
   `maker_in = maker_margin + maker_change`; all amounts < 2^100.
6. Outputs: pair record commitment over (deployment, market, size, entry, both margins, funding snapshot, taker
   owner, maker owner, new rec_nonce, blind); change notes; fee record. Pair record encrypted to the risk key
   and to the taker; both ciphertext hashes public.
