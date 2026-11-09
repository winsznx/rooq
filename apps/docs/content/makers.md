Makers are the other side of every perp position. A maker posts private backing and sets the spreads it's willing to trade at. Takers fill against that backing.

Anyone with a private balance can post backing from the **Maker desk**.

## Posting backing

| Setting | What it does |
| --- | --- |
| Market | Which perp market you back |
| Backing | How much of your private balance to lock |
| Largest fill | The most any one taker can open against this lock |
| Open spread | How far from the oracle price you sell or buy, in basis points |
| Close spread | What a taker pays to close against you, for the life of the position |
| Expiry | When this offer ends |

Each fill uses only the margin it needs. The rest stays reserved until your lock expires or is filled.

## The close spread is a promise

When you take a position, you commit to a close spread. The taker can then close at any time at the oracle price less that spread, without your signature. You price that promise through the spread you set. You can't refuse a close later.

## Your side of the risk

- You hold the opposite of every taker you back. If the price moves against you, you lose.
- Your margin must stay above maintenance. If it doesn't, the position closes at the oracle price and a penalty comes out of your side.
- If your taker has gone and you want out, use a [forced exit](/closing-and-liquidation#forced-exit). It takes 7 days.
- You can't unshield backing that's in a lock or a position. It has to be released first.
- Expired locks return to your private balance.

## What takers and others can see

```who-sees
Public chain | - Not which maker backs any fill
Your taker | - Not who you are. A taker can't see who backs its position
Coordinator | A one-time address and the terms of your lock
Risk workers | A one-time address on each position
You | Your own quotes and fills
```

Spreads and how quickly you quote can still help someone guess who you are, especially in a market with few makers.
