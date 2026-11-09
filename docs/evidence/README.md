# Evidence index (2026-11-07)

| File | What it proves |
|---|---|
| `00-tests-first-forge-build.txt` | Tests were written before the contracts existed (compile fails on missing sources) |
| `01-forge-test.txt` | 98 Foundry tests passed, including fuzz, stateful invariants and Rust parity |
| `02-cargo-test.txt` | 10 Rust kernel tests passed |
| `03-testnet-deploy-dryrun.txt` | Full deploy simulated against live Robinhood Chain testnet state |
| `walkthrough-local.json` | The acceptance walkthrough executed onchain on local anvil: 43 steps with tx hashes, blocks, gas, events and conservation checks |
| `playwright-report.json` | Browser flow (connect, deposit, consent, quote, review, confirm, close) and accessibility results |
| `indexer-*.json` | Indexer reorg and restart drills (written by the indexer drill scripts) |

Local relay sample (writes real Robinhood reference prices into the local TEST feeds):
`price_written TSLA answer 35945000000 bid 358.9 ask 360 multiplier 1.0 sourceAt 2026-11-07T18:16:56Z`
