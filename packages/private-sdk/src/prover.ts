import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";
import type { InputMap } from "./witness";

export type { CompiledCircuit };

export interface Proof {
  readonly proof: Uint8Array;
  /** Public inputs as the verifier sees them, in circuit order. */
  readonly publicInputs: readonly string[];
}

/**
 * Executes the circuit on `inputs` and proves it with UltraHonk in EVM mode (ZK, keccak transcript).
 * Witness execution fails here, before any proving, when a constraint does not hold.
 */
export class Prover {
  private constructor(
    private readonly api: Barretenberg,
    private readonly circuit: CompiledCircuit,
    private readonly backend: UltraHonkBackend,
  ) {}

  static async create(circuit: CompiledCircuit, threads = 4): Promise<Prover> {
    const api = await Barretenberg.new({ threads });
    return new Prover(api, circuit, new UltraHonkBackend(circuit.bytecode, api));
  }

  async prove(inputs: InputMap): Promise<Proof> {
    const { witness } = await new Noir(this.circuit).execute(inputs);
    const p = await this.backend.generateProof(witness, { verifierTarget: "evm" });
    return { proof: p.proof, publicInputs: p.publicInputs };
  }

  async verify(p: Proof): Promise<boolean> {
    return this.backend.verifyProof({ proof: p.proof, publicInputs: [...p.publicInputs] }, { verifierTarget: "evm" });
  }

  async destroy(): Promise<void> {
    await this.api.destroy();
  }
}
