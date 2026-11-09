# ADR-P03 proving-stack benchmark

Same two statements (`STATEMENT.md`) on two stacks. Results and the decision are in
`docs/privacy/ADR-P03-proving-stack.md`; raw output is in `results/`.

Hardware: Apple M1 Pro, 8 cores (6P+2E), 32 GB, macOS (Darwin 27). No discrete GPU.

## Toolchain pins

| Tool | Version | Install |
|---|---|---|
| nargo / noirc | 1.0.0 (`275d3ab1`) | `noirup` |
| bb (Barretenberg) | 5.3.0 | `bbup -v 5.3.0` (bbup has no 1.0.0 mapping yet; pairing verified by prove/verify below) |
| @aztec/bb.js | 5.3.0 | `cd wasm && npm install` |
| noir-lang/poseidon | v0.4.0 | Nargo git dep |
| noir-lang/keccak256 | v0.1.3 | Nargo git dep |
| RISC Zero r0vm / cargo-risczero | 3.0.6 | `rzup install` |
| risc0-groth16 | 0.1.0 | `rzup install risc0-groth16` |
| risc0-ethereum contracts | v3.0.1 | `git clone --branch v3.0.1` into `evm/lib/risc0-ethereum` |
| solc | 0.8.28 | foundry |

## Commands

```sh
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.risc0/bin:$PATH"

# Noir: witnesses (the maker signature is made with anvil account 1, a public test key)
cd zk/bench/noir
nargo test --package transfer --show-output | python3 ../toml.py > transfer/Prover.toml
./gen-perp.sh
nargo execute --package transfer && nargo execute --package perp_open
bb gates -b target/perp_open.json
bb write_vk -b target/perp_open.json -o out/perp_open -t evm
/usr/bin/time -l bb prove -b target/perp_open.json -w target/perp_open.gz -k out/perp_open/vk -o out/perp_open -t evm
bb verify -k out/perp_open/vk -p out/perp_open/proof -i out/perp_open/public_inputs -t evm
./negative.sh                                    # 19 single-field mutations must fail witness generation

# Solidity verifiers and gas (local EVM)
bb write_solidity_verifier -k out/perp_open/vk -o ../evm/src/perp_open_verifier.sol -t evm
cd ../evm && forge test -vv --match-contract HonkGas

# WASM (browser engine) proving
cd ../wasm && node bench.mjs perp_open 4

# RISC Zero (uses the prebuilt r0vm; building the prover from source fails, see ADR-P03)
cd ../risc0 && cargo build --release -p host
./target/release/host perp_open succinct 1
./target/release/host transfer groth16 1
cd ../evm && RISC0_IMAGE_ID=<IMAGE_ID printed by host> forge test -vv --match-contract Risc0Gas
```
