## What Rooq does

Rooq lets you trade stock tokens privately on Robinhood Chain testnet. You can do two different things with the same asset.

**Spot** means you own the token. You swap one token for another through a Rooq pool. Nothing can be liquidated.

**Perps** means you trade the token's price with leverage. You don't receive the token. You post margin, take a long or short position, and your position can be closed by force if margin runs out.

Both are private by default. Your balance, your position, your trades and your profit or loss are not published on the chain in readable form.

## How it stays private

Tokens you move into Rooq sit in one shared contract. Inside it, your balance is a set of encrypted notes that only your device can read. When you trade, your browser makes a zero-knowledge proof. The proof shows the chain that your trade follows the rules, without showing the trade.

Anyone can check that every accepted action followed the rules. Nobody needs to see your account to check it.

Privacy has limits, and they matter. Moving tokens in and out of Rooq is public. The maker on the other side of a position can see that position. Risk workers can see what they need to liquidate. Timing and amounts can sometimes reveal a link. [How privacy works](/how-privacy-works) shows exactly who can see what.

## This is testnet

Rooq runs on Robinhood Chain testnet. Test tokens have no value and you can't turn them into money. Use them to learn the product.

- Rooq has not been audited.
- Leverage can lose your entire margin.
- Prices on testnet come from a single relay that Rooq runs, so they are not an independent oracle.
- Rooq is an independent project. It isn't affiliated with or endorsed by Robinhood.

A Stock Token gives you price exposure. It does not give you shares or shareholder rights.

## Where to go next

Read [how privacy works](/how-privacy-works) and the [risks](/risks) first, then [set up your account](/getting-started). If you build on Rooq, go to [API and SDK](/api-and-sdk) and [Contracts](/contracts).
