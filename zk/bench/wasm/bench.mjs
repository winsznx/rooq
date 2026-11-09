// Proves the Noir benchmark circuits with bb.js WASM (the engine a browser wallet would run) and verifies.
// Usage: node bench.mjs <transfer|perp_open> <threads>
import { readFileSync } from "node:fs";
import { Barretenberg, BackendType, UltraHonkBackend } from "@aztec/bb.js";

const [name = "transfer", threadsArg = "1"] = process.argv.slice(2);
const threads = Number(threadsArg);
const circuit = JSON.parse(readFileSync(`../noir/target/${name}.json`, "utf8"));
const witness = readFileSync(`../noir/target/${name}.gz`);
const api = await Barretenberg.new({ backend: threads > 1 ? BackendType.WasmWorker : BackendType.Wasm, threads });
try {
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  await backend.getVerificationKey({ verifierTarget: "evm" });
  const t0 = performance.now();
  const proof = await backend.generateProof(witness, { verifierTarget: "evm" });
  const ms = performance.now() - t0;
  const ok = await backend.verifyProof(proof, { verifierTarget: "evm" });
  const rss = Math.round(process.memoryUsage().rss / 2 ** 20);
  console.log(`RESULT op=${name} backend=wasm threads=${threads} prove_s=${(ms / 1000).toFixed(2)} verified=${ok} proof_bytes=${proof.proof.length} rss_mb=${rss}`);
} finally {
  await api.destroy();
}
