# Security

Rooq runs on Robinhood Chain testnet and has not been audited. Test assets have no value, but a flaw that breaks privacy or custody matters before any mainnet release.

## Reporting a vulnerability

Report privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Please don't open a public issue for anything that could affect funds or privacy. You can also email contact@rooq.trade.

Include what you found, the contract, circuit or service involved, and steps or a transaction that shows it. We'll confirm receipt and keep you updated until it's fixed. With your permission, we credit reporters in the fix.

## In scope

- Contracts in `contracts/src/privacy/`
- Circuits in `zk/circuits/`
- `packages/private-sdk/` and `apps/private-services/`
- Anything that lets someone learn a hidden balance or position from public data, spend a note they don't own, or move funds outside the rules

The transparent reference build (`contracts/src/perps`, `src/spot`, `src/market`, `apps/maker`, `apps/indexer`, `apps/api`) is not deployed and is out of scope.
