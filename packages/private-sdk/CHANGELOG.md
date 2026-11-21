# Changelog

## 0.1.0

First public release.

- Targets Rooq's Robinhood Chain testnet deployment (chain 46630, pool 0x4285fb6228ddE782782086f241f8Aa89fDDFb364) with record version 2.
- Keys, notes, encryption, note tree, scanning, perps and spot witnesses, outcome helpers and the UltraHonk `Prover`.
- Relay fee outputs on lock, update, close, release and redeem, defaulting to a zero-value note to self.
- LP price band helpers, including open-ended ranges.
- Account and deposit derivation bound to the deployment.
- `@rooq/private-sdk/legacy/v1`: read-only decoders for record version 1.
