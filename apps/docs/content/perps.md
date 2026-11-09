A perp lets you trade a token's price with leverage. You don't receive the token. You post margin, take a side, and profit or lose as the price moves.

## A position is a matched pair

Every position has two sides, you and one maker. If you go long, your maker is short. Each side posts its own margin in that position alone. Profit for one side is loss for the other, and nothing else pays out.

Margin is isolated. A loss in one position can't reach your other positions or the rest of your balance. Each position has one maker.

## Long and short

- **Long** makes money when the price goes up.
- **Short** makes money when the price goes down.

You can't flip from long to short in one trade. Close first, then open the other side.

## Leverage and margin

Leverage is your position's value divided by your margin. Each market sets two levels.

- **Initial margin** is the minimum to open a position.
- **Maintenance margin** is the level below which a position can be liquidated.

Higher leverage means less margin for the same size and a liquidation price closer to the current price. Each market's numbers are fixed when it's deployed. The trade ticket shows them, and you can read them from the contract.

### Numbers on testnet

These apply to the five testnet markets (TSLA, AMZN, PLTR, NFLX and AMD), and come from tier B of the testnet risk settings. Always check the ticket.

| Setting | Value |
| --- | --- |
| Initial margin | 50% (up to 2x leverage) |
| Maintenance margin | 35% |
| Liquidation penalty | 1% of position value |
| Taker fee | 0.06% |
| Maximum funding | 0.01% per hour |
| Market open interest limit | $100,000 |
| Largest single position | 100 units of the token |

### An example

Example only. You go long 1 token at $250 with $125 of margin. That's 2x leverage.

- The price goes up 10% to $275. You gain $25, which is 20% of your margin, before fees and funding.
- The price goes down 10% to $225. You lose $25, which is 20% of your margin.
- Liquidation comes well before your margin runs out. At about $192, your remaining margin falls below 35% of the position's value.

## Opening a position

There's no order book. You place a private lock, and a maker's standing offer fills it.

1. Enter the size, your margin and how long you'll wait for a match.
2. Rooq shows the worst price you accept, the initial margin and the most you can pay in fees.
3. Your browser makes a proof and locks your margin privately.
4. The coordinator matches your lock with a maker's lock. The fill price is the oracle price plus or minus that maker's spread.

The match has to pass every check before it settles. Both sides must meet initial margin. The price must be fresh and within your limit. The market must be under its open interest limit, and funding must have run within the last hour.

A match isn't guaranteed. If nothing matches by your expiry, your margin comes back.

## Changing a position

- **Add margin** moves more of your private balance into the position. It works even when the price is stale.
- **Remove margin** needs a fresh price, and you must stay above initial margin afterward. Gains only count up to what your counterparty has posted.
- **Reduce** closes part of the position at the oracle price less your maker's spread. It needs a fresh price.

Every change creates a new private version of the position. All changes look the same on the chain, so nobody can tell a margin top-up from a funding payment.

You can't add to a position. A second lock opens a separate position with its own entry, margin and maker. The app shows them together.

```who-sees
Public chain | - That a position opened or changed in a market. No size, side, price or owner
Your maker | That position, and nothing else about you
Coordinator | The terms of each lock it matches, against one-time addresses
Risk workers | What's needed to check health, against one-time addresses
You | Everything
```

Read on for [funding and fees](/funding-and-fees) and [closing and liquidation](/closing-and-liquidation).
