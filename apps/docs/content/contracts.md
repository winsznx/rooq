Rooq's contracts live on Robinhood Chain testnet, chain ID 46630. They can't be upgraded and have no admin function that moves funds. A change means a new deployment.

Rooq has not been audited.

```slot:contracts-table
```

## Fixed numbers

These are constants in the contracts. You can read each one from the explorer.

| Constant | Value | What it means |
| --- | --- | --- |
| `EXIT_DELAY` | 7 days | Wait for a forced exit |
| `EXIT_BOND` | 0.001 ETH | Refundable bond for a forced exit |
| `ORACLE_DEAD_AFTER` | 14 days | Without a fresh price, a matured exit settles at entry |
| `INSURANCE_SWEEP_AFTER` | 90 days | When a dead market's insurance moves to the fee address |
| `MAX_FUNDING_WINDOW` | 1 hour | The most time one funding period can charge |
| `MAX_FUNDING_STALENESS` | 1 hour | New positions need funding this recent |
| `TREE_DEPTH` | 32 | Size of the note tree |
| `ROOT_HISTORY` | 64 | Recent tree states a proof can use |

## Set per deployment

Each market's numbers are fixed when it's deployed and can't change. Read them with `market(id)` on `PrivatePairs`, and read each pool with `pool(id)` on `PrivateSpot`. The values on the first testnet market are on the [Perps page](/perps#numbers-on-testnet).

The fee address, coordinator key and both risk keys are also fixed at deployment. You can read those from `PrivatePairs` too.

The first testnet feeds accept a price from $1 to $100,000 and treat it as fresh for up to 7 days. Testnet prices come from a single relay that Rooq runs.

## Who holds which power

`PrivatePairs` and `PrivateSpot` have no admin. The people who run Rooq hold only these roles.

| Role | What it can do | What it can't do |
| --- | --- | --- |
| Oracle admin | Approve or revoke a price feed | Move funds or change a live market's rules |
| Price relay operator | Write the testnet price, within the feed's bounds | Move funds |
| Coordinator | Match locks and fill spot requests inside signed limits | Change any term or move funds |
| Risk workers | Read positions, liquidate unhealthy ones and settle funding | Touch healthy positions beyond funding, or move funds |

A revoked feed or a stopped relay blocks new positions, closes and liquidations until a fresh price arrives or the [dead-oracle rules](/closing-and-liquidation#if-the-price-feed-dies) apply.

## How to verify a contract

1. Open the address on the [explorer](https://explorer.testnet.chain.robinhood.com).
2. Check the contract's source against the Rooq code. Rooq publishes source through Sourcify, which needs no account.
3. Use **Read contract** to check the constants above and `deploymentId()`.
4. Check that each verifier address read from `PrivatePairs`, such as `lockVerifier()`, matches the verifier contract you reviewed.
5. Compare any token address against the table above before trusting it. Copycat tokens exist on this chain.

## What the chain shows

| Event | What it shows |
| --- | --- |
| `Shielded` | Token, amount, wallet and encrypted note reference |
| `Unshielded` | Token, recipient, amount, relayer and fee |
| `RecordCreated` | A record's commitment and ciphertext. Only the record kind is readable |
| `PairOpened`, `PairClosed` | A market and a commitment or spent marker |
| `PairLiquidated` | A market, a spent marker and the price |
| `FundingAdvanced` | A market's funding index and time |
| `PoolUpdated` | A pool's new private state |

No event includes an account next to a private amount.
