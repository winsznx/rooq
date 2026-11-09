Read this before you trade. Rooq is testnet software and it can fail in ways that matter.

## Testnet and unaudited

Rooq runs on Robinhood Chain testnet. Test tokens have no value and can't be turned into money. Rooq has not been audited. The contracts, circuits and services may have bugs that lose funds or expose private data. Don't use anything on Rooq that you care about.

## Trading risks

- **You can lose your entire margin.** Leverage makes small price moves large. A position can be liquidated quickly.
- **Liquidation has a cost.** A penalty is charged on top of your loss.
- **Prices can gap.** A price can jump past your estimated liquidation price.
- **Winners can be short-paid.** A gain is limited by the other side's margin and that market's insurance. Any remainder is written off.
- **Funding can drain a position.** It's paid continuously and can push you toward liquidation.
- **A healthy position can still close.** If your maker falls below maintenance, your position closes at the oracle price.
- **A match isn't guaranteed.** There's no order book, and there may be no maker when you want one.

## Risks of holding Stock Tokens

A Stock Token gives you price exposure. It does not give you shares, votes or dividends. Availability varies by country, and Rooq has no location controls on testnet.

## The price feed

Testnet prices come from a single relay that Rooq runs, using Robinhood's public reference price. The operator can set any price within the feed's bounds, and a bad price can liquidate a position. It isn't an independent oracle. If the relay stops, new positions, closes and liquidations wait for a fresh price.

## Privacy limits

Trading privately still has limits. Shields and unshields are public. Makers see their own positions. Risk workers see what they need to liquidate. Timing and amounts can reveal links, especially in quiet markets. A service that has read your data can keep it. [How privacy works](/how-privacy-works) has the full list.

## Your keys

Whoever controls your wallet controls your private account. If you lose it, nobody can help. Never sign the account message anywhere except Rooq, because a phishing site that gets that signature gets your account. A compromised browser or device can read your keys, as with any web wallet.

## Services and the chain

Rooq depends on a coordinator, risk workers, a relayer and a price feed, and they can stop or fall behind. If risk workers fall behind, positions may not be liquidated on time, and losses can grow past margin. Your exit routes depend on the chain being up, and closing needs a fresh price.

## Changes

Rooq's contracts can't be upgraded. A fix means a new deployment and a move to it. Risk settings on testnet are set for testing. Testnet deployments can be replaced, and test balances may not carry over.
