/**
 * Proof of possession for operator and fee keys (audit #18). Each key holder runs this on its own host and hands over only
 * the proof; the secret never leaves the process and is never printed.
 *
 *   COORDINATOR_SK=… RISK_A_SK=… RISK_B_SK=… FEE_SEED=… \
 *     bun run src/key-pop.ts --deployment <id> [--epoch 0] --out <dir>
 *   … --pool <PrivatePairs address> --chain-id <id> instead of --deployment
 *
 * Genesis (epoch 0) needs all four; a rotation needs the coordinator and risk slots it changes, at the epoch it would become.
 * Only slots whose secret is set are proved. Each proof lands at <out>/<slot>/proof, the layout PRIVACY_POP_DIR expects.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { deriveKeys, initCrypto, Prover, type CompiledCircuit } from "@rooq/private-sdk";
import { REPO_ROOT, takeScalar } from "./lib/config";
import { deploymentIdOf, proveKeyPop, writeKeyPops, type KeyPop, type PopSlot } from "./lib/key-pop";

const { values } = parseArgs({
  options: { deployment: { type: "string" }, pool: { type: "string" }, "chain-id": { type: "string" }, epoch: { type: "string", default: "0" }, out: { type: "string" } },
  strict: true,
});
if (!values.out) throw new Error("--out is required");
const deployment = values.deployment !== undefined
  ? BigInt(values.deployment)
  : values.pool !== undefined && values["chain-id"] !== undefined
    ? deploymentIdOf(BigInt(values["chain-id"]), values.pool)
    : null;
if (deployment === null) throw new Error("pass --deployment, or --pool with --chain-id");
const epoch = BigInt(values.epoch ?? "0");

await initCrypto();
const env = process.env;
const secrets: [PopSlot, bigint][] = [];
for (const [slot, name] of [["coordinator", "COORDINATOR_SK"], ["risk_a", "RISK_A_SK"], ["risk_b", "RISK_B_SK"]] as const) {
  if (env[name]) secrets.push([slot, takeScalar(env, name)]);
}
if (env.FEE_SEED) secrets.push(["fee", deriveKeys(takeScalar(env, "FEE_SEED")).encSk]);
if (secrets.length === 0) throw new Error("set at least one of COORDINATOR_SK, RISK_A_SK, RISK_B_SK, FEE_SEED");

const circuit = JSON.parse(readFileSync(`${env.CIRCUITS_DIR ?? `${REPO_ROOT}zk/circuits/target`}/key_pop.json`, "utf8")) as CompiledCircuit;
const prover = await Prover.create(circuit, Number(env.PROVER_THREADS ?? 4));
try {
  const pops: KeyPop[] = [];
  for (const [slot, sk] of secrets) pops.push(await proveKeyPop(prover, sk, deployment, epoch, slot));
  const files = writeKeyPops(values.out, pops);
  for (const [i, p] of pops.entries()) console.log(`${p.slot} x=${p.key.x} y=${p.key.y} -> ${files[i]}`);
  console.log(`deployment ${deployment} epoch ${epoch}`);
} finally {
  await prover.destroy();
}
