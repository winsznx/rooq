## Funding

Funding is a payment between the two sides of a position. It keeps perp prices close to the oracle price by charging the crowded side.

When more of the open positions are long, longs pay shorts. When more are short, shorts pay longs. The rate grows with the imbalance, up to the market's maximum.

Funding moves only between the two sides of a position. It never creates money and never comes from insurance.

### How it accrues

A funding period is folded into the market by a proof that anyone with a coordinator or risk key can run. Each period counts at most one hour of time.

- If periods stall for longer than an hour, the extra time isn't charged later. Funding is under-charged in that case.
- If the price is stale when a period runs, that period charges nothing.
- New positions are refused if funding hasn't run in the last hour. Liquidations are not.

Funding keeps settling while you're away. A risk worker can settle it on your position without your key. On a healthy position, that's the only change it can make without you.

### If someone can't pay

When a side can't cover funding from its margin, the unpaid amount stays on the position as a debt. It's collected at the next settlement. When the position closes, the debt is taken out of the payer's gain first. Anything that still can't be collected is written off, and your receipt shows what was owed and what was paid.

### Public signal

Each market's funding index is public, so anyone can see the balance of longs and shorts. In a market with only one open position, the index reveals that position's direction.

## Fees on perps

The taker pays a fee on the fill's value when opening, reducing and closing. The rate is set per market at deployment. It's 0.06% on the five testnet markets.

- Fees go to a fee address fixed at deployment, as a private note, so per-trade fee amounts aren't public.
- On a close or reduce, the fee is capped by what you have left, so a fee can never stop you from closing.
- Forced exits and liquidations pay no fee. A liquidation pays the penalty instead.

Makers don't pay a trading fee. They earn the spread they set.

## Fees on spot

Each pool charges a fee on swaps that stays in the pool for its liquidity providers. It's 0.30% per pool on testnet.

## Gas and relayers

Network fees are paid in test ETH on testnet. Public actions like shielding use your wallet. Private actions go through a relayer that pays the gas, so you don't need to fund a public account to trade. A relayer may charge a fee as a private note, and the app always shows it first.

| You pay | When | Goes to |
| --- | --- | --- |
| Taker fee | Open, reduce, close | Fee address |
| Pool fee | Spot swaps | Liquidity providers |
| Funding | While a position is open | The other side of your position |
| Liquidation penalty | If liquidated | Half to the risk worker, half to insurance |
| Relayer fee | Some private actions | The relayer |
| Gas | Public actions | The network |
