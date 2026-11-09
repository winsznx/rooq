# Private V1 decision log

Decisions the addendum reserves for the founder. On 2026-11-08 the founder delegated them to the implementing agent
with the instruction to pick the best answer on the merits, not the cheapest to build, and to keep this log. Each
entry can be reversed by the founder. Anything still marked planned is decided but not yet built.

| ID | Question | Decision | Status |
|---|---|---|---|
| D-01 | F1: maker identity on fills | Hidden per fill | Built (per-lock addresses) |
| D-02 | F2: aggregate publication policy | Hourly, thresholded, no per-trade data | Planned (W4) |
| D-03 | ADR-P09 D1: funding shortfall | Enforceable per pair against the payer's own gain, remainder written off | Built in `liquidate` |
| D-24 | REC-07: rotating the coordinator and risk keys | 24 hour public delay, a key guardian, old keys kept until old records have moved on | Built (`contracts/src/privacy/PrivateMarkets.sol`, services, `docs/privacy/KEY_INCIDENTS.md`) |
| D-04 | ADR-P10: does PAUSED block exits | No state may stop an exit or a liquidation | Holds today (no pause exists); keep in W3A |
| D-05 | ADR-P04: relayer fee on private transfers | Paid as a shielded note | Built |
| D-06 | Linking one wallet's positions | Fresh payout address per lock | Built |
| D-07 | Amounts published by liquidation | None: rewards, insurance, shortfalls and bad debt are all private | Built |
| D-08 | Where funding is computed | Private open interest, public per-epoch index | Built |
| D-09 | Noir and bb version pairing | Keep bb 5.3.0, confirm against the published map before freeze | Open check |
| D-10 | How a taker closes when the maker refuses or vanishes | Maker commits a standing close spread at open; taker closes alone | Built |
| D-11 | Forced exit and what it may touch | Owner-proved request, 7-day wait, pair margins only, never insurance | Built |
| D-12 | Price to use when the oracle is dead | No price: settle at entry after 14 days without a fresh one | Built |
| D-13 | Increasing a position | A second lock opens a separate isolated pair; no in-place increase | Built (open_pair) |
| D-14 | Changes to a live pair | One update proof for funding, margin and partial reduce, with the same public shape for all | Built |
| D-15 | Fees | Paid as shielded notes to a deployment-fixed address | Built |
| D-16 | Open interest limit with private, lagging OI | Check against the last folded total plus a worst case for everything unfolded | Built |
| D-17 | Insurance left in a market that has ended | To the fee address after 90 days with no oracle and no positions | Built |
| D-18 | Spot execution order | Sequential in tree order per pool, so an operator cannot reorder trades | Built |
| D-19 | How swaps and LP actions are authorized | Owner signs bounded intents; the operator can only fill them inside those bounds | Built |
| D-20 | How spot shares custody with perps | One tree and one vault, separate pool records, no financial path between them | Built |
| D-21 | How a user gets a private account | Connect a wallet and sign once; the account derives from that signature, with passkey unlock | Working locally in the browser |
| D-22 | Creating markets privately | Permissionless, on fixed risk tiers and approved feeds, with a creator bond behind insurance | Working locally, real proofs |
| D-23 | Risk workers reading intents | Locks are encrypted to both risk keys as well, so a worker can execute or refund if the coordinator is gone | Working locally for spot and liquidity. Workers don't match perps locks yet |

## D-01. Maker identity

Hide it per fill from public observers and from the taker. Publish only per-market backing, in the D-02 aggregates.

The cheaper answer was to publish which maker backs a market. That lets anyone attribute fills in any market with
one maker, which is most new markets. Makers still see their own quotes and fills (PRIV-01). The admitted maker list
stays public as governance, and the link from a maker to a specific fill does not. D-06 is what makes this true at the
record level: a taker's pair holds a one-time maker address, not a stable one.

Residual risk: RFQ responses and quote timing can still identify a maker. ADR-P04 owns that.

## D-02. Aggregate publication

- No per-trade feed, exact trade size or account-linked tape (PRIV-05).
- Fixed, non-overlapping, UTC-aligned one-hour windows per market.
- Published: notional volume, open interest and fill-count bucket, each rounded to two significant figures.
- A window is published only if it has at least 10 fills, at least 2 distinct admitted makers, and no single fill
  above 25% of the window's notional.
- A window that fails rolls into the next one and is published as a single combined window. Boundaries are fixed and
  never restated, so differencing two releases cannot isolate a fill.
- Per-market funding index (D-08) and epoch-end insurance balance, coarsened, are approved aggregates. Per-event
  insurance amounts are not (D-07).

Why a dominance rule as well as a count: the system cannot tell that several notes belong to one person, and PRIV-05
says they do not count as several participants. A fill-count floor alone can be met by one actor splitting orders. The
25% cap limits what any release says about one fill even then. It does not stop a determined Sybil, and the disclosure
copy must say so. Attacker-controlled observation over time is tested under PV-24.

## D-03. Funding shortfall

Replaces ADR-P09 D1 for the private system. The write-off let a payer with no margin left but a winning position keep
the whole gain while skipping funding it owed. Now the unpaid amount is netted against that payer's PnL gain from the
same pair when it closes, and stays with the counterparty, who was owed it.

- Beneficiary: the pair's other side. Priority: before any PnL is paid to the payer.
- Never drawn from insurance or the creator bond, as before.
- Anything left after netting is written off and reported as shortfall in the private receipt, with owed and paid.
- Payer health counts the unpaid amount, so a position cannot look healthy by not having paid.

The legacy transparent contracts keep the write-off, because they exist only for migration exits. The parity
requirement in ADR-P09 applies to everything except this one rule, and `crates/risk-kernel` must add it.

## D-04. Emergency stops

No paused, frozen or degraded state may block owner reduction or close, liquidation, unshield, or lock refund. An
emergency stop can only stop new exposure. Reason: "pause" is exactly when users most need out, and MARKET-04 forbids
disabling the only safe exit.

Legacy `ClearingHouse.liquidate` rejects PAUSED, so the private status machine must not be copied from it. The legacy
behavior is recorded here and left unchanged.

## D-05. Relayer fee on private transfers

Pay the relayer a shielded note as a third spend output, encrypted to the relayer's address, which the relayer checks
before submitting. The asset and amount stay hidden. The rejected option was a public fee, which reveals the asset of
every private transfer.

## D-06. Per-lock addresses

Each lock pays out to a one-time address derived from the seed at a new index. Without this, a risk worker or the
coordinator could cluster every position of a wallet, which LIQ-02 forbids. Spending keys stay separate per address.
Restore finds the addresses from the owner's own lock ciphertexts, which stay encrypted to the main key.

Cost: restore tries each ciphertext against each of the wallet's lock addresses. That bound belongs in REC-09.

## D-07. What liquidation publishes

Nothing about amounts. The earlier prototype published the insurance share, covered amount and bad debt, which bound the
position size. Now a liquidation publishes only the fact that a pair in a market was liquidated at the mark.

- The worker's reward is a shielded note.
- The insurance share and any shortfall go into a hidden market-state change on the same queue as open interest.
- The winner gets a claim record for the shortfall. Every liquidation creates one, with amount 0 when there is no
  shortfall, so its presence reveals nothing.
- The funding epoch folds a batch: penalty shares in, then every claim in the batch is paid the same ratio,
  `min(1, insurance / claims)`. Order inside a batch cannot change a payout, and the queue is chain-ordered, so no
  coordinator chooses who is paid first.
- The ratio is public and exactly 1 whenever insurance covers the batch. It reveals something only when a market is short.
- Insurance and bad debt live in the private market record, and reach the public only as D-02 aggregates.

Cost: a winner in a shortfall is paid the covered part after the next epoch instead of at liquidation.

Forced closes (D-11) still do not draw on insurance.

## D-08. Funding

Open interest stays private in a per-market commitment. Opens and liquidations do not touch it directly. Each appends
a hiding commitment of its size change to a per-market queue, and a `funding_epoch` proof folds the queue and publishes
that epoch's index change. Liquidations therefore cannot be blocked by contention on a shared record, which is what
a single live record updated on every trade would have allowed (LIQ-07).

- The index is public, so the long/short skew ratio is public. Publishing the rate is standard for perps and it lets
  anyone check settlement. In a market with one open position it reveals that position's direction. That goes in the
  disclosure text (PRIV-04, PRIV-05).
- New exposure is refused when funding is more than one hour stale (LIQ-08). Liquidation is not.
- An epoch must use the current time and consume all pending changes up to its batch limit, so a prover cannot skip
  changes or claim several capped windows after a stall (ADR-P09 D3).

## D-09. Toolchain pairing

Keep bb 5.3.0, which is proved and verified end to end by generated verifiers. Barretenberg's published version map did
not list Noir 1.0.0 when checked. Re-check before circuit freeze and regenerate all verifiers if the pairing changes.

## D-10. Taker close

The legacy engine closes through a maker-signed quote, so a maker that refuses or disappears traps the taker. Here the
maker's lock commits a close spread, and the pair carries it. The taker alone proves a close at any time at the mark
less that spread. The maker gave that promise when it took the trade and can price it through the spread. The rejected
option was a fresh maker signature per close, which keeps the trap.

A close needs a fresh oracle and full payment from both sides. An underwater pair belongs to liquidation, so closing can't
be used to dodge the penalty or short-pay the counterparty.

## D-11. Forced exit

Either owner proves it owns a side of a live pair and posts a refundable 0.001 ETH bond. Seven days later anyone holding
the pair's plaintext can close it at the mark with no spread and no penalty. A taker rarely needs this because of D-10.
It exists for a maker whose taker has gone, and for the dead-oracle case.

- The request is keyed by the pair's nullifier. Root updates and other trades cannot move its deadline (REC-03).
- Only an owner can open one, so nobody can grief a position or freeze a market. Liquidation still applies during the
  wait, and the bond comes back either way.
- Forced closes pay only from the pair's own margins and never touch insurance or the bond. Sequential insurance draws
  would make payouts depend on who settled first, which REC-04 rules out. A loser that cannot pay short-pays only its
  counterparty, shown in the private receipt.

Insurance left in a market that has ended follows D-17.

Seven days was chosen to be longer than any plausible maker outage and shorter than the time collateral can reasonably
sit idle. It is a parameter the founder may want to tune.

## D-12. Dead oracle

If a matured exit finds no fresh price for 14 days, the pair settles at its entry price: price PnL is zero, funding still
applies, and each side keeps its own margin. REC-05 forbids silently picking a stale favorable mark, and any last price
is favorable to someone. Before 14 days the exit stays pending, and that state's release condition is a fresh price.
The timer uses the later of the feed's own timestamp and the last fresh price this contract saw, so a revoked feed
cannot skip it.

## D-13. Increasing a position

There is no in-place increase. A second lock opens a separate pair with its own entry, margin and maker. One-time addresses
(D-06) would otherwise need the two positions linked, and averaging entries across makers breaks the one-maker-per-position
rule (PERP-01). The wallet shows a user's pairs in a market together. Every open passes the full PERP-02 checks.

## D-14. Live pair updates

`pair_update` handles funding settlement, adding and removing margin and partial reduce in one circuit. Every update
publishes the same fields, including an open-interest change of size 0 when nothing was reduced, so an observer can't tell
a margin top-up from a funding settlement. With no owner key it can only settle funding, which is what lets funding keep
moving while owners are away. Unpaid funding is carried on the pair as a debt and collected at the next settlement,
making D-03 enforceable across a position's life.

Removal uses initial margin at a fresh mark, counting gains only up to what the counterparty posted, as the legacy engine
does. Adding margin and settling funding work with a stale oracle (LIQ-08).

## D-15. Fees

The taker pays the market's fee on open, reduce and taker close, on the fill's notional as in the legacy engine. It goes
to a fee address fixed at deployment, as a shielded note, so per-trade fee amounts are not public. On a close or reduce
the fee is capped by what the taker has left, so a fee can never trap an otherwise valid exit (PERP-06). Forced closes
and liquidations pay none; liquidations pay the penalty instead. Fee rates are immutable per deployment, which replaces
the legacy per-trade maximum fee check.

## D-16. Open interest limit

The limit stays in USD at the mark, as in the legacy engine, but total open interest is private and lags until the next
epoch. Each open proves the last folded total, plus every unfolded change counted as a maximum-size open, plus its own
size, is within the limit. It can only be too strict: a long backlog pauses new opens until an epoch runs, which anyone
holding a key can do. The alternative of counting only folded interest would let a burst exceed the limit.

## D-17. Insurance after a market ends

Once a market's oracle has been dead for 90 days, no change is pending and a proof shows no position is open, its
insurance moves to the fee address as a shielded note. The alternatives were leaving funds stranded forever in a contract
with no admin, or paying short-paid winners of forced closes, whose claims are not recorded by design (D-11). Penalties
funded this balance and no live claim can reach it. If the oracle ever returns, the market continues with empty
insurance and any bad debt still recorded.

## D-18. Spot ordering

Pools execute one intent at a time, and each pool remembers the tree position of the last intent it ran. An intent can only run
if it sits later in the tree. The operator therefore cannot reorder trades, and cannot put its own trade ahead of one it has
already seen, because its own intent would land later in the tree. It can still leave an intent out: that intent cannot run later
and refunds at expiry, and the trader's minimum output bounds anything else (SPOT-03). The rejected option was free ordering
limited only by each trader's slippage bound, which leaves room for sandwiching up to that bound.

Cost: a skipped intent has to be placed again.

## D-19. Swap and LP authorization

Reserves are private and a shared pool record changes on every trade, so a wallet cannot prove a swap against reserves it cannot
see and which would be stale by the time it landed. The wallet instead escrows funds into a bounded intent: asset, amount,
minimum out, route, expiry and payout address. The operator proves execution against the live pool. It cannot change any term, and
if it does nothing the funds refund at expiry without it. LP add takes two linked locks. LP removal is a request the owner signs,
with minimum amounts, that returns to idle if ignored, and works in every state (D-04).

## D-20. Spot and perp isolation

Both use one note tree and one token vault, so a user's free balance moves between them without a public transfer. Pool reserves
and share supply live in per-pool records, and no circuit connects a pool record to a market record, so a perp loss cannot reach
spot reserves or LP claims (SPOT-06). The spot contract can only consume records and add leaves on the shared tree. It cannot move
tokens.

## D-21. Private account keys

The founder rejected making people generate and back up a seed phrase in the browser. A user connects a normal wallet with RainbowKit and signs one fixed message. The private account's seed is derived from that signature, so the same wallet restores the same account on any device with nothing extra to back up.

- No server ever receives the signature, seed or keys. Keys are derived and used in the browser, held in memory while unlocked.
- "Remember this device" stores the seed encrypted, under a passkey (WebAuthn PRF) where supported, otherwise with a non-extractable device key. It is never stored in plain text and never in localStorage.
- The signature is checked twice at setup. Some smart-contract and MPC wallets return different signatures each time, and those cannot derive a stable key. They use a passkey-derived seed instead. The generated seed and its backup step were removed, so a wallet that can't sign deterministically on a device without a passkey can't open an account.
- Risks that remain and must be stated to users: a phishing site that gets the same message signed gets the private account, so the message says what it does and to sign it only on Rooq. Whoever controls the wallet controls the private account. A compromised front end could read keys in the browser, as with any web wallet, so the app runs under a strict content security policy with no third-party scripts near key handling.

## D-22. Private market creation

Anyone can create a market on a risk tier fixed at deployment and an approved, fresh oracle feed, with one market per feed. The creator's bond moves into custody and stands behind the market's shortfalls after its insurance (PERP-07). Creator identity and bond size are public by policy; positions are not. A creator can only stop new positions, and takes back the unused part of the bond once the market is closed and a proof shows no open positions. Feeds still need approval by the oracle admin, so an asset without a feed is honestly ineligible (MARKET-01).

Markets created this way use the testnet risk tiers in config/risk-testnet.json, which replaces the 10x test values in the deploy script for anything on testnet.

## D-23. Who can read an intent

A lock used to be readable only by its owner and the coordinator, so a dead coordinator left swaps and liquidity adds waiting for the owner. Locks are now also encrypted to both risk keys, so a defined surviving party can execute or refund them (REC-06). This widens who can see an unexecuted order to the risk workers, which section 2.1 of the addendum allows within their assigned scope.

## D-24. Rotating the coordinator and risk keys (REC-07)

The coordinator key and the two risk keys were fixed at construction. They are now stored in PrivatePairs and change only through a delayed rotation that lives in PrivateMarkets, because PrivatePairs has no room. The getters `coordinatorX` to `riskBY` are unchanged. PrivateSpot now reads keys from custody on every call instead of copying them at deployment.

**No circuit or verifier changes.** Keys were already public inputs, supplied by the contract. A circuit uses them only to encrypt new data, never to check who owns an old record. Liquidation reads an old pair with whichever key the worker holds and encrypts the new claim to the keys in effect now. So old obligations keep working the moment the keys change.

**Who and how long.** A `keyGuardian` address, fixed at deployment, can schedule or cancel a change of all three keys. Anyone can activate it once 24 hours have passed. There is no shorter emergency path. A 24 hour delay leaves a compromised key readable for up to a day longer, and it gives users and operators a public day to see a change and object before it can read anything new. A guardian that goes bad is limited to reading what is encrypted after activation, including old positions that are updated after it. It cannot move money, change a market, change margin or touch a record. On testnet the deployer holds this role, which is disclosed. Before real use the guardian should be a multisig: the address cannot be changed after deployment and a stolen guardian key cannot be undone by anyone but itself canceling.

**What a key change cannot do.** It revokes future access only. Anyone who read a position, lock or market record before the change still knows it. A rotation cannot erase what was already learned, and nothing in this design claims to.

**Why a wrong key is refused.** A changed key must be a valid Grumpkin point and must never have been used before. Without the curve check, a bad key would make every proof that encrypts to it unsatisfiable, which is exactly the outcome a rotation must not cause, including for liquidation. Reuse is refused so a retired, possibly leaked key cannot be brought back. A key nobody holds cannot be detected on chain, so the guardian should schedule only after the new key is loaded and showing as held.

**Old records keep their key until they move.** A worker holds the current key plus any retired ones (`RISK_SK_PREVIOUS`, `COORDINATOR_SK_PREVIOUS`). Which key opens a record is decided by the record itself, checked against its commitment or the on-chain head, so no history is guessed. Retired keys stay usable as long as any live pair, lock, claim or market record still needs them. A worker migrates live pairs forward on its own with the same keyless update funding settlement uses, which changes no margin or size. The health endpoint reports `retiredKeyRecords`; when that reaches zero on both workers and the coordinator, the retired key can be destroyed. A retired key never needs to be destroyed as an incident response, and doing so while it still has work would strand old records.

**Costs.** One more contract role to guard. Six more storage reads per proof, which is small next to verification. A retired key must be kept available until old records clear, so a compromised retired key keeps its old access until they do: rotation stops new exposure, it does not cut off what the old key could already read. The ciphertext formats and verifiers are unchanged, so a deployment made before this change simply has no rotation and keeps working as before.
