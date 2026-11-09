# ADR-P03: Proving stack, composition, setup and chain-46630 verification

Status: RECOMMENDED (W1): Noir + Barretenberg UltraHonk. Chain-46630 verification PASSED for the benchmark verifier
(PV-02, `docs/privacy/evidence/pv02-46630.txt`). The production circuit verifiers are not deployed.
Addendum refs: ZK-01..06, section 4.1, DEPLOY-04.

## Question

Which proving stack carries Rooq's private transitions: a purpose-built circuit stack (Noir + Barretenberg) or a
Rust zkVM (RISC Zero)? Measured on the same two representative Rooq transitions, not on guesses.

## Method

`zk/bench/STATEMENT.md` defines two statements implemented once per stack with the same checks:

- Op A, private transfer: 2 input notes with depth-32 membership, owner authorization, nullifiers, conservation,
  2 output commitments, 2 in-proof encryptions bound to the recipients' keys.
- Op B, private perp open: taker note spend, maker backing record with shared-record nullifier, keccak-256
  EIP-712 digest computed in-proof from every quote field and checked against the Solidity encoding byte for
  byte, secp256k1 ECDSA, maker address derivation, quote expiry at batch time, oracle commitment and deviation
  bound, both-side initial margin, fee, four output records, pair record encrypted to the risk key and the taker.

Hardware: Apple M1 Pro (8 cores), 32 GB. Commands and pins: `zk/bench/README.md`. Raw output: `zk/bench/results/`.

## Results

| Measure | Noir 1.0.0 + bb 5.3.0 UltraHonk (ZK, keccak transcript) | RISC Zero 3.0.6 |
|---|---|---|
| Op A size | 13,781 gates | 946,065 user cycles (1 segment of 2^20) |
| Op B size | 149,841 gates | 1,302,982 user cycles (2 segments) |
| Op A prove, native, 8 threads | 0.22 to 0.25 s, 31 to 36 MB peak (5 runs) | 180.9 s succinct, 4.1 GB peak (CPU; see findings) |
| Op B prove, native | 1.41 to 1.74 s, 333 to 340 MB peak (5 runs) | 371 s succinct, about 6.7 GB peak (run partly overlapped other proving, upper bound) |
| Op A prove, WASM (bb.js, browser engine, Node) | 2.47 s 1 thread / 1.25 s 4 threads, 404 to 643 MB | not available in a browser |
| Op B prove, WASM | 24.9 s 1 thread / 9.4 s 4 threads, 461 to 598 MB | not available in a browser |
| EVM-verifiable form | Native output | Groth16 wrap: Op A 658 s (partly contended) on top of execution |
| Proof bytes on chain | 8,000 (A) / 9,536 (B) + public inputs = 8,352 / 10,240 calldata bytes | 256-byte seal + 4-byte selector; journal digest computed onchain |
| Verifier gas, local EVM (Foundry, cancun) | 2,357,967 (A) / 2,621,430 (B) | 227,441 |
| Verifier contract size | 17,413 B / 17,786 B runtime (under EIP-170) | RiscZeroGroth16Verifier, standard deployment |
| Negative checks | 19 single-field witness mutations fail (`results/noir-negative.txt`); flipped proof bytes, each of 22 public inputs flipped, and the other circuit's proof all rejected by the Solidity verifier | tampered journal digest and wrong image id rejected |
| Trusted setup | Universal BN254 SRS (no per-circuit ceremony) | Fixed Groth16 setup for RISC Zero's recursion circuit; guests need none |
| Composition | Recursive ZK Honk verification in Noir: 2 client proofs folded in 1,470,299 gates, 9.69 s, 2.3 GB | Receipt composition in the zkVM (not measured) |

## Findings beyond the numbers

1. Client proving decides it. ZK-04 defaults to client proofs for free-balance ownership so spending keys and
   unrelated wallet state never leave the device. Barretenberg proves Op B in 9.4 s in WASM with 4 threads, inside
   the founder's 15 to 30 s allowance. RISC Zero needs minutes and gigabytes on a laptop CPU and has no browser
   prover, so every owner spend would need a remote prover that reads the owner's witness. That breaks the
   default visibility boundary rather than tuning it.
2. On-chain cost favors RISC Zero by about 10x (227k vs 2.4 to 2.6M gas, 260 B vs 8 to 10 KB calldata). On an
   Arbitrum-family chain the calldata posted to L1 is likely the larger cost. Mitigation inside the Noir stack:
   the coordinator folds client proofs into one batch proof (measured: about 735k gates and 4.8 s per folded
   proof), so the chain verifies one UltraHonk proof per batch instead of one per operation.
3. Recursive verification is deferred. A tampered inner proof passes `nargo execute` and `bb prove` of the
   aggregation circuit; only the outer verification fails. The coordinator must verify every client proof
   natively before folding it, or one bad submission wastes a whole batch (a liveness issue, not soundness).
4. Witness-supplied Grumpkin points are not checked by the stdlib curve operations. The benchmark library adds
   `assert_on_curve`; production circuits must do the same for every key taken from a witness.
5. RISC Zero from source did not build on this Mac: risc0-sys 1.5.0's Metal kernels fail with the installed
   Metal compiler (`poseidon2.metal: use of overloaded operator '=' is ambiguous`). The prebuilt `r0vm` ran on
   CPU only (536% CPU). GPU proving would shorten the times, but not to browser-usable and not in a browser.
6. Version pairing: `bbup` has no published Barretenberg mapping for Noir 1.0.0 yet. bb 5.3.0 (npm `latest`) was
   chosen and every artifact proved and verified with it. Before circuit freeze the pair must be confirmed against
   Aztec's release notes or moved to an officially mapped pair. bbup warns that bb below 0.82.2 had a critical
   UltraHonk soundness bug; 5.3.0 is past that fix.
7. Independence: with Noir the financial arithmetic is a second implementation, so `crates/risk-kernel` stays an
   independent reference for differential tests (addendum section 17). A RISC Zero guest would most naturally
   reuse the kernel, making the reference and the implementation the same code.
8. The image id printed as u32 words is not the byte string the EVM verifier expects; the first Groth16 check
   failed for that reason until the bytes were reordered. The host now prints the digest bytes.
9. Not isolated by a negative test: the oracle deviation bound in Op B. Changing the oracle price also breaks the
   oracle commitment, so that mutation fails for the wrong reason. The production suite needs a fixture whose
   oracle commitment matches an off-deviation price.

## Decision

Recommend Noir + Barretenberg UltraHonk, ZK mode, keccak transcript for EVM verification (`-t evm`), BN254,
Poseidon2 for commitments/tree/nullifiers, Grumpkin ECDH + Poseidon2 keystream for in-proof encryption.

Composition: owner-branch client proofs (spend, intent authorization) produced in the wallet; a coordinator
batch circuit recursively verifies them (`-t noir-recursive`, proof type 6) and applies the shared-state
transitions (pairs, maker records, pools, markets) whose witnesses it is entitled to (ADR-P01 O5); one batch
proof is verified on chain per batch. Per-operation on-chain verification stays available as the fallback path
for forced requests (REC-03), since it needs no coordinator.

Revisit if: on-chain verification of one batch proof on 46630 costs too much in L1 data fees, in which case a
final Groth16-style wrap of the batch proof is the next option to measure.

Routine engineering selection per addendum 4.1; it does not change the privacy boundary, custody model or loss
allocation.

## What is still not shown

- Full gas accounting on 46630. `cast estimate` returned 4,116,515 for the benchmark verifier there, against 2,621,430 of
  execution gas locally. The difference has not been broken down. Local EVM gas is from Foundry with the cancun EVM; Arbitrum-family chains also charge for
  L1 data, so calldata size (8 to 10 KB per proof) matters and must be measured on the chain.
- Browser proving in an actual browser tab (Node WASM was measured; browsers add worker and memory limits).
- Audit coverage of the exact versions: to be listed from primary sources before freeze, not assumed.
