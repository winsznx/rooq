Every proof you make on Rooq is checked by a verifier contract on chain. You shouldn't have to take our word that those verifiers belong to the circuits in the repository. This page shows how to rebuild them yourself and compare the result with what's deployed.

There are two commands. The first rebuilds the circuits, verification keys, Solidity verifiers and their compiled bytecode from source, and writes a manifest of hashes. The second reads the chain and checks each deployed contract against that manifest. Neither sends a transaction.

## What's pinned

The build only counts if everyone uses the same tools. They're listed with their sha256 hashes in `zk/toolchain.lock`:

- nargo 1.0.0 (noirc commit `275d3ab1`) to compile the circuits
- bb 5.3.0 to write the verification keys and verifiers
- forge 1.7.1 and solc 0.8.28 to compile the verifiers
- the slice of the Aztec Ignition CRS that bb reads, the same file the browser prover uses
- the Poseidon hash library, kept in `zk/vendor/poseidon` so the build never downloads it
- the OpenZeppelin and forge-std submodule commits

The build checks all of these before it starts and stops if anything differs.

## Rebuild

From a clean checkout of the commit you want to check:

```sh
git submodule update --init
scripts/repro-build.sh
```

It takes about a minute on a laptop. It compiles in a scratch copy under `zk/target/repro`, so nothing in your checkout changes. At the end it prints a table of every circuit and contract, then `official true` and a `manifest_sha256` line. That hash is what a deployment record pins.

The build fails if the verifiers in `contracts/src/privacy/verifiers` or the keys in `zk/circuits/keys` differ from what it produced. Run it twice and you get the same manifest both times.

For each circuit, the manifest records the hash of the compiled circuit (the ACIR bytecode, not the whole artifact, which contains paths from your machine), the verification key and its hash, the size and number of public inputs, and the verifier source. For each contract, it records the hash of the compiled code with the library addresses and constructor values blanked out, plus where those blanks sit.

### In Docker

The reference build runs on linux-amd64 in a container with no network access:

```sh
scripts/repro-build.sh --docker
```

This builds the image from `zk/Dockerfile.repro`, which downloads each pinned tool and checks its hash, then runs the same script inside it with the repository mounted read-only. Build the image yourself rather than pulling one.

We compared a linux-amd64 build with a build on an Apple Silicon Mac and got the same manifest, byte for byte. On Apple Silicon, Docker's default Rosetta emulation can't run the linux bb binary and stops with "Illegal instruction". Run the Docker build on an x86_64 machine, or use the native build.

## Check a deployment

```sh
scripts/verify-deployment.sh contracts/deployments/privacy-46630.json
```

It reads the deployment record, rebuilds the commit named in its `build` block, and requires the manifest hash to match the one in the record. Then it checks the chain:

- Each library's code matches the build, and its call-protection slot holds its own address.
- Each verifier's code matches the build once the library links and constructor values are blanked out. Each link points at the recorded library. `$VK_HASH`, `$LOG_N`, `$NUM_PUBLIC_INPUTS` and `$MSMSize` read from the code equal the values from the rebuilt verification key. The full code hash equals the one in the record.
- `PrivatePairs`, `PrivateSpot` and `PrivateMarkets` match the build, and they link the recorded `PairInputs`.
- Every verifier getter, like `spendVerifier()` or `swapVerifier()`, returns the verifier the record lists for that circuit.
- `deploymentId()` on each contract equals the chain ID shifted left 160 bits, combined with the pool address.

It prints one PASS or FAIL line per check and exits with an error if any check fails. It only calls `eth_chainId`, `eth_getCode` and `eth_call`. Pass `--rpc` to use your own node, and `--docker` to rebuild in the container.

A record without a `build` block predates reproducible builds. The script says so and stops, because nothing in that record names the commit to rebuild.

## If a check fails

A different `manifest_sha256` means your tools or your source differ from the deployment's. The build output lists any tool that drifts from the lock. A failed code check on one verifier while the others pass usually means that circuit changed. Compare its `acir_sha256` and `vk_hash` with the record.

If you think a deployed verifier doesn't match its circuit, write to {{support_email}}.
