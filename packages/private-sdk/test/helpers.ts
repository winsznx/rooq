import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CompiledCircuit } from "@noir-lang/noir_js";

export function circuit(name: string): CompiledCircuit {
  const path = fileURLToPath(new URL(`../../../zk/circuits/target/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as CompiledCircuit;
}

/** Contract constant `ShieldedPool.EMPTY_ROOT`, read from source so the test fails if either side changes. */
export function contractEmptyRoot(): bigint {
  const path = fileURLToPath(new URL("../../../contracts/src/privacy/ShieldedPool.sol", import.meta.url));
  const m = /EMPTY_ROOT = (0x[0-9a-f]{64});/.exec(readFileSync(path, "utf8"));
  if (!m?.[1]) throw new Error("EMPTY_ROOT not found in ShieldedPool.sol");
  return BigInt(m[1]);
}
