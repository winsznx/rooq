Liquidity providers deposit two tokens into a pool. Traders swap against it, and the pool keeps a fee on each swap.

## Adding liquidity

You pick a pool, two amounts and an expiry. Rooq makes two private locks, then the pool takes them.

- The pool takes its exact ratio and refunds the rest to your private balance.
- The first depositor sets the pool's starting price.
- If nothing fills by your expiry, your tokens come back.

Pool reserves are private, so the app works from a rounded price when it suggests amounts.

The operator can read your request and could trade ahead of it to move the pool price before your deposit goes in. To limit that, the app reads the pool price when you submit and only lets the deposit run if the pool mints at least the shares that price implies, less your slippage limit from Settings. If the price moves further, or the pool has earned more in fees than that limit, the deposit doesn't run and your tokens come back at expiry. That price comes from Rooq's operator, so it narrows the risk rather than removing it.

The very first deposit leaves a small amount of share supply locked in the pool for good, 1,000 units. This protects the pool's math from manipulation when it's nearly empty.

## What you earn

The pool fee is 0.30% on testnet. It stays in the pool, so the value of your share grows with it. Test tokens have no value, so the fees are for learning how it works.

## What you can lose

When the price of one token moves against the other, the pool ends up with more of the token that fell. Your share can be worth less than if you had held the two tokens. This is called impermanent loss, and it becomes permanent when you withdraw.

Rooq's pools are separate from perps. A loss on a perp position can't reach pool reserves or your liquidity.

## Removing liquidity

Removing is a private request you sign with the minimum amounts you'll accept.

1. Choose how much to remove, your two minimums and an expiry.
2. The operator fills it.
3. Your tokens arrive as private notes.

If the operator ignores the request past expiry, your share goes back to idle, and you can try again. If you leave the minimums blank, the app sets them from the current pool price and your slippage limit, which stops the operator moving the price far against you before it fills the request. That price comes from Rooq's operator, so check it against the market if the amount matters, and enter your own minimums if you want a tighter bound.

```who-sees
Public chain | - That a pool changed. Not your share or the amounts
Operator | The pool's reserves and its own pool records. Not your wallet
You | Your share and history
```

In a thin pool, one person's deposit can be inferred from the change in the published totals. [How privacy works](/how-privacy-works#what-can-still-link-you) explains this.
