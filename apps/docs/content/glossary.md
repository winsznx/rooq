**Backing.** Private funds a maker locks to take the other side of positions.

**Close spread.** What a maker commits to charge when a taker closes. It's set when the position opens.

**Commitment.** A hash published on the chain that stands for a private record without revealing it.

**Coordinator.** The service that matches locks and fills spot requests inside the limits you signed.

**Designated risk worker.** See risk worker.

**Fill price.** The price your position opens at, the oracle price plus or minus your maker's spread.

**Forced exit.** A way to close a position after 7 days when the other side has gone.

**Free balance.** Private funds you can trade, send or unshield now.

**Funding.** A payment between the two sides of a position that depends on the balance of longs and shorts.

**Funding index.** A public running total for a market that positions settle funding against.

**Health.** How far a position's margin is above maintenance.

**Initial margin.** The minimum margin to open a position.

**Insurance.** A market's pool, funded by liquidation penalties, that helps cover shortfalls in that market only.

**Isolated margin.** Margin that belongs to one position. A loss there can't reach anything else.

**Leverage.** A position's value divided by its margin.

**Liquidation.** The forced close of a position whose margin has fallen below maintenance.

**Lock.** Private funds committed to a trade or offer, with an expiry after which they come back.

**LP claim.** Your private share of a spot pool.

**Maintenance margin.** The level below which a position can be liquidated.

**Maker.** The side of a position that posts backing and sets a spread.

**Mark.** The current oracle price used to value positions.

**Matched pair.** A position with exactly one taker and one maker on opposite sides.

**Note.** An encrypted record of private funds. Your balance is a set of notes.

**Nullifier.** A marker published when a note is spent, so it can't be spent twice. It doesn't show which note it was.

**One-time address.** A fresh address for each lock, so one wallet's positions can't be linked.

**Oracle.** The source of a market's price. On testnet it's a single relay that Rooq runs.

**Open interest.** The total size of open positions in a market.

**Operator.** The service that fills private spot requests.

**Private address.** What someone needs to send you a private transfer. It reveals neither of your keys.

**Proof.** A cryptographic check that a private action follows the rules without showing its details.

**Private account.** The keys that hold your private balance. They come from one wallet signature, or from a passkey or a generated phrase.

**Recovery phrase.** A generated set of 24 words, for wallets that can't sign the same way twice. They spend and restore that account.

**Relayer.** A service that pays gas and submits your proofs, so your public wallet isn't involved.

**Risk worker.** A service that can read positions so it can liquidate them while you're offline.

**Shield.** Move tokens from a public wallet into your private balance. This step is public.

**Short-paid.** Paid less than you were owed because the other side and insurance couldn't cover it.

**Slippage.** How far a price can move against you before a swap stops.

**Spot.** Trading the token itself. Nothing can be liquidated.

**Stale price.** A price too old to use. New positions, closes and liquidations wait for a fresh one.

**Stock Token.** A token on Robinhood Chain that tracks a stock's price. It doesn't give you shares or shareholder rights.

**Taker.** The trader who opens a position against a maker.

**Unshield.** Move tokens from your private balance to a public address. This step is public.

**USDG.** Global Dollar, the token used for margin and as the spot quote token on Rooq.

**Zero-knowledge proof.** See proof.
