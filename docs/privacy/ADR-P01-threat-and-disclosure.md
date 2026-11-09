# ADR-P01: Threat model, field-level visibility and permitted leakage

Status: DRAFT (W0). Closes when the W1 state schema (ADR-P02) fixes every public input and ciphertext field and
PV-01's automated inventory agrees with the tables below. Addendum refs: PRIV-01..06, section 2.1, DATA-04..06, OPS-05.

## Context

Today every economic fact in Rooq is public: `MarginVault.Moved`, `ClearingHouse.TradeExecuted/PositionChanged/
FundingSettled/Liquidated`, `SpotPool.SwapExecuted/LiquidityAdded`, `QuoteConsumed`, address-keyed storage readable
by `eth_call`, and API routes that take any wallet address (`/account/:wallet`). The founder chose public
confidentiality with narrow maker and risk-service visibility. This ADR fixes who may learn which field.

## Observers

| Observer | Capabilities assumed |
|---|---|
| O1 Public chain observer | Reads all calldata, storage, events, reverts, traces, gas, timing, ERC-20 transfers; can simulate any call |
| O2 Active attacker with own accounts | O1 plus: shields, trades, LPs and requests quotes from attacker-controlled identities, adaptively and over time (PRIV-05 differencing) |
| O3 Quote maker | Its own quotes, fills and paired exposure; its request metadata as limited by RFQ-06 |
| O4 Designated risk worker | Decrypts the risk ciphertext of pairs assigned to it; generates forced transitions |
| O5 Settlement coordinator / prover worker | Sees the witnesses it is handed for shared-state proofs (pool reserves, pair state it settles) |
| O6 Relayer | Sees the proof and public inputs it submits, plus network metadata of whoever hands it the bundle |
| O7 Rooq API / view service operator | Request metadata, authenticated sessions, any data the user chooses to send |
| O8 Compromised user device | Out of scope for confidentiality (PRIV-02). Recovery and revocation still apply (REC-07) |

Collusion assumptions: O1/O2 colluding with O3 is assumed (makers can be attackers). O4 colluding with anyone
learns its assigned pairs; that is disclosed, not prevented (PRIV-02). Custody and arithmetic correctness must
hold even if O3, O4, O5, O6 and O7 all collude (PRIV-03). Confidentiality from O5 holds only for witnesses not
handed to it (ZK-04).

## Keys and credentials (domain-separated, FUNDS-02)

| Credential | Holder | Authorizes | Never used for |
|---|---|---|---|
| Wallet EOA key | User's existing wallet | Public ERC-20 approve/transfer for shield; signing the private-account derivation message once | Private spends |
| Spending key `sk` | Private wallet only | Owner-branch transitions (spend, trade, close, unshield) | Viewing, risk access |
| Nullifier key `nk` | Derived from `sk`, never leaves wallet in owner branch | Canonical consumption identity per record (see STATE-07 below) | |
| Incoming viewing key `ivk` | Private wallet; scoped exports only | Decrypting own notes | Spending (proof never accepts it as authority) |
| Risk encryption keys `rk_i` | Each designated risk worker separately | Decrypting assigned pair state | Spending free notes |
| Recovery material | User backup (mnemonic) | Re-deriving `sk`, `ivk` | |
| Maker quote key | Maker hot key (as today) | Signing RFQ terms (private witness) | Moving funds |

STATE-07 consequence: the consumption identity of a pair record must be computable by risk workers without `nk`.
Design direction for ADR-P02: pair records carry a record nonce chosen at admission and the nullifier is
`H(domain, record_commitment, record_nonce)` revealed to the owner and to the assigned risk scope, so owner close
and forced liquidation produce the same nullifier and one of the two fails at acceptance.

## Field visibility (default maximum; implementation may disclose less)

| Field | O1/O2 | O3 maker | O4 risk | O5 coordinator | Notes |
|---|---|---|---|---|---|
| Shield deposit: token, amount, depositor EOA, time | Public | Public | Public | Public | ERC-20 transfer cannot be hidden (PRIV-04) |
| Unshield: token, amount, recipient, time | Public | Public | Public | Public | Same |
| Link between a deposit and later private notes | Hidden | Hidden | Hidden | Hidden unless the deposit note itself is handed to it | |
| Free note value, asset, owner | Commitment + ciphertext only | No | No | No | Client proves free-balance spends (ZK-04) |
| RFQ request (market, side, size) | Hidden | Its own requests | No | Settlement scope only | Quote service must not broadcast wallet/IP/size tuples (RFQ-06) |
| Accepted fill: size, price, fee | Hidden | Own fills | Assigned pairs | Pairs it settles | |
| Pair: size, entry, margins both sides, funding snapshot | Hidden | Own side and counterparty pair it is in | Assigned pairs | Pairs it settles | |
| Funding owed/paid/shortfall per pair | Hidden | Own pairs | Assigned pairs | Pairs it settles | Market-level totals: see aggregates |
| LP claim value and owner | Hidden | No | No | Pool scope, not owner wallets | |
| Pool reserves, share supply | Aggregate disclosure under PRIV-05 policy (ADR-P07) | | | Full | Exact reserves after each batch reveal batch net flow; ADR-P07 must decide |
| Market OI, insurance, bad debt, unpaid funding totals | Aggregate disclosure under PRIV-05 policy | | | Full | Exact totals per batch can reveal single trades in thin markets |
| Market metadata, risk tiers, feeds, oracle reports, verifier keys | Public | Public | Public | Public | |
| Creator/admin/guardian identities and actions | Public | | | | |
| Maker identity on a fill | Hidden from O1 | Self | Assigned | Settles | Open question F1 below |
| Proof public inputs | Public | | | | Must contain only roots, nullifiers, commitments, ciphertext hashes, policy/oracle refs, boundary amounts |
| Batch size, gas used, calldata size, inclusion time | Public | | | | Fixed-shape batches or padding decided in ADR-P02/P07 |

## Permitted residual leakage (must appear in user-facing disclosure, PRIV-01 text)

1. Boundary transfers: amounts, addresses, timing. Distinctive amounts and immediate in-out link deposits to withdrawals.
2. Quotes: a maker learns the requester's intent; adaptive quote probing around a single victim reveals pool state.
3. Aggregates: in sparse markets, a reserve or OI delta for a batch with one participant equals that participant's trade.
4. Timing and batch metadata: a batch with one intent reveals that an intent occurred at that time.
5. Risk workers retain whatever they decrypted; rotation does not erase it (PRIV-02, REC-07).

## Prohibited (release blockers)

- Any event, storage slot, revert reason or public input containing an account address next to a private amount.
- API routes keyed by wallet address that return private data without authentication (today: `/account/:wallet*`).
- `/quotes/recent` (maker service) and forwarding client IP to makers (`apps/api/src/routes.ts`, quote proxy).
- Public execution fallback when proving or the coordinator fails (PRIV-06).
- Logging plaintext quote bodies, witnesses, notes or keys.

## Founder decisions

F1 and F2 below are decided in `DECISION_LOG.md` (D-01, D-02).

- F1. Maker identity on fills: hide from O1 (default here) or publish which maker backs a market. Maker backing
  commitment per market is currently public (`BackingChanged`). Default: hide per fill, publish only aggregate
  per-market backing.
- F2. Aggregate publication policy (windows, minimum distinct contributions, suppression). Proposal goes in
  ADR-P07; it changes what O1 sees, so it needs sign-off.

## Verification plan (PV-01, PV-24)

- Script that ABI-decodes every event, storage layout entry and public-input schema of `contracts/src/privacy/*`
  and fails if a field outside the "Public" column appears.
- Capture of API logs and responses during the full walkthrough, grepped for synthetic account addresses and
  amounts.
- Manual review of calldata/gas/timing for a single-participant batch with the observer recording what it infers.
