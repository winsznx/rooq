## Closing your position

You can close alone, at any time, with no maker signature. Your maker committed to a close spread when the position opened, and that promise lasts for the life of the position. You close at the oracle price less that spread.

A close needs a fresh price, and both sides must be able to pay in full. A position that's already underwater goes to liquidation instead.

You pay the taker fee on the amount you close, capped by what you have left.

## Liquidation

A position can be liquidated when a side's margin falls below maintenance at a fresh oracle price. This happens whether or not either trader is online.

Hidden positions can't be found by just anyone, so Rooq uses two risk workers, each with its own key. They can read the positions they need to watch. A worker proves the position is below maintenance and closes it. It can't choose the price, change the payouts or touch anything else.

### What happens

1. Funding settles first.
2. The whole position closes at the oracle price. Both sides are checked, taker first.
3. A penalty is charged to the side being liquidated, 1% of position value on the first testnet market. It's capped by what that side has left.
4. Half the penalty goes to the worker as a private note and half goes to that market's insurance.
5. Your remaining margin comes back to your private balance. Your account finds it on the chain even if you were offline the whole time.

If the maker is the one below maintenance, the position still closes at the oracle price and you are paid your gain out of the maker's margin. You lose the position even though you were healthy.

The liquidation price shown in the app is an estimate. Funding, fees and fast price moves can change it.

### If a loss is bigger than margin

Prices can jump past your liquidation price. A loss can't take more than the margin in that position. If the loser's margin can't cover the winner's gain, the winner gets a claim on that market's insurance for the difference.

Claims are paid after the next funding period at one shared ratio. If insurance covers all of them, they're paid in full. If it doesn't, every claim in that batch is paid the same reduced share. The winner is short-paid by the rest, and the rest can't be recovered. Rooq has no auto-deleveraging and no cross-market support.

```who-sees
Public chain | - That a position in a market was liquidated, and the price. No amounts
Risk workers | The position they liquidate
You | Your full receipt, decrypted on your device
```

The ratio is public. It only drops below 1 when a market can't cover its claims, which reveals that it's short.

## Forced exit

A forced exit is for when the other side has gone. A taker rarely needs it because a taker can already close alone. It's there for a maker whose taker has disappeared, and for a dead oracle.

1. Either owner proves they own a side of the position and posts a refundable bond of 0.001 ETH. In the app, the relayer posts it.
2. The clock runs for 7 days. Nothing can extend it.
3. After 7 days, the position closes at the oracle price with no spread and no penalty. In the app, a risk worker does this at the next fresh price.

Liquidation still applies during the wait, and the bond comes back either way. A forced exit pays only from the two margins in that position. It never draws on insurance. A loser who can't pay short-pays the other side, and your receipt shows it.

### If the price feed dies

A position can't close while its price is missing, so it waits. If no fresh price has arrived for 14 days, a matured exit settles at the position's entry price. Price profit and loss is zero, funding still applies and each side keeps its own margin.

If a market's oracle has been dead for 90 days, no change is left to process and no position remains, its insurance moves to the fee address.

## What no state can stop

Rooq has no pause on private positions. No status, operator or admin can block a close, a reduce, a liquidation, an unshield or a lock refund. `PrivatePairs` and `PrivateSpot` have no admin.

These actions still need the chain to be running, and closing and liquidation need a fresh price.
