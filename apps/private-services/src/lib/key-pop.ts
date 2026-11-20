import { mkdirSync, writeFileSync } from "node:fs";
import { keyPopWitness, mulGenerator, type Point, type Prover } from "@rooq/private-sdk";

/** Key slots in PrivateMarkets order; the index is the circuit's `slot` input. */
export const POP_SLOTS = ["coordinator", "risk_a", "risk_b", "fee"] as const;
export type PopSlot = (typeof POP_SLOTS)[number];

/** ShieldedPool's deployment id: chain id above the custody address. */
export function deploymentIdOf(chainId: bigint, pool: string): bigint {
  return (chainId << 160n) | BigInt(pool);
}

export interface KeyPop {
  readonly slot: PopSlot;
  readonly key: Point;
  readonly proof: Uint8Array;
}

/**
 * Proves that the holder of `encSk` holds the key it schedules, for one deployment, key epoch and slot. The proof is checked
 * locally before it is returned, so a holder never hands the deployer a proof the contract would refuse.
 */
export async function proveKeyPop(prover: Prover, encSk: bigint, deployment: bigint, epoch: bigint, slot: PopSlot): Promise<KeyPop> {
  const w = keyPopWitness({ encSk, deployment, epoch, slot: BigInt(POP_SLOTS.indexOf(slot)) });
  const proof = await prover.prove(w.inputs);
  if (!(await prover.verify(proof))) throw new Error(`key_pop proof for ${slot} did not verify`);
  return { slot, key: mulGenerator(encSk), proof: proof.proof };
}

/** Writes each proof as `<dir>/<slot>/proof`, raw bytes, the layout DeployPrivatePairs reads from PRIVACY_POP_DIR. */
export function writeKeyPops(dir: string, pops: readonly KeyPop[]): string[] {
  return pops.map((p) => {
    mkdirSync(`${dir}/${p.slot}`, { recursive: true });
    const file = `${dir}/${p.slot}/proof`;
    writeFileSync(file, p.proof);
    return file;
  });
}
