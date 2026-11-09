A market is one token paired with USDG. It can have a spot pool, perps, or both.

## How markets are added

In the private release, markets and pools are set when the contracts are deployed. There's no button that creates one on a live deployment. Adding a market means a new deployment. It's separate from the old one, so you move funds yourself by unshielding from one and shielding into the other.

This keeps the rules fixed. Nobody can change a live market's fee, margin levels or price feed.

## What a token needs

A token goes through the same checks whether it's spot only or has perps.

| Check | Why |
| --- | --- |
| Verified identity | Tickers aren't unique on this chain. A market is tied to one exact address |
| Normal transfer behavior | Rooq checks that the amount received is exactly the amount sent |
| Starting liquidity for spot | The first deposit sets the price |
| Approved price feed for perps | The feed has to be tied to this exact token |
| Risk settings for perps | Margin, penalty, fee and size limits |
| Risk workers ready for perps | Positions have to be liquidatable from the first trade |

A token without an approved feed can still be spot only. Rooq doesn't invent a price to make a token eligible.

## Market states

Prices are public, and each market has rules that apply to everyone.

- New exposure is blocked when the price is stale or funding is out of date.
- Closing, reducing, adding margin, unshielding and refunds are never blocked by a market's state.
- A market with a dead price feed follows the [dead-oracle rules](/closing-and-liquidation#if-the-price-feed-dies).

## Suggesting a market

To suggest a token or a market, email [{{support_email}}](mailto:{{support_email}}) with the token's address and where its price comes from.
