A spot swap trades one token for another against a Rooq pool. You end up holding the token in your private balance. There's no margin and nothing can be liquidated.

## How a private swap works

1. You pick the tokens, the amount and the time you're willing to wait.
2. Rooq shows an estimate and works out your minimum from your slippage limit.
3. Your browser makes a proof and places a private swap request. Your tokens are locked inside it.
4. The operator fills the request against the live pool. It can only fill it at or above your minimum.
5. You get the output as a new note. If nothing fills by the expiry, your tokens come back.

Nothing about the terms can be changed after you sign. The operator can fill it inside your limits, or leave it.

## Estimates and your minimum

Pool reserves are private, so nobody can compute an exact price from public data. The quote service rounds its answer to four significant figures, so what you see is an estimate. **Your minimum is what binds.**

Slippage defaults to 0.50%, and you can set it anywhere from 0.01% to 5% in **Settings**. Expiry is yours to choose, and defaults to one hour.

Quotes are limited to 30 per minute for each client, plus a limit per pool. This makes it harder to work out a pool's reserves by asking for many quotes.

## Routing

A swap goes through one pool or through two. Each testnet pool pairs a Stock Token with USDG, so going from one Stock Token to another uses two pools with USDG in the middle. Both steps happen as one action, and you never hold the token in the middle.

Rooq only routes through its own pools. It won't send your trade to a public exchange, because a public route would show the trade.

## Fees

The pool fee on testnet is 0.30% per pool, taken from the amount going in. It stays in the pool for liquidity providers. A two-pool route pays it twice.

## Order of trades

Pools process requests one at a time, in the order they entered the chain's note tree. This stops the operator from reordering trades or putting its own trade ahead of one it has seen.

The operator can still skip a request. If that happens, your request expires and your tokens come back. Your minimum protects you from everything else.

```who-sees
Public chain | - That a pool changed. Not the amount, the token direction or the trader
Operator | The swap it fills, against a one-time address
You | Everything
```

## What you hold

After a swap you hold the token in your private balance, backed one for one by real tokens in the contract. Unshield it whenever you like. A Stock Token gives you price exposure and no shares or shareholder rights.
