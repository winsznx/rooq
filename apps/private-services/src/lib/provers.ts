import { readFileSync } from "node:fs";
import { Prover, type CompiledCircuit } from "@rooq/private-sdk";
import { REPO_ROOT } from "./config";

/** Compiled circuits load on first use, so a process pays only for the proofs it makes. */
export class Provers {
  private readonly loaded = new Map<string, Promise<Prover>>();

  constructor(private readonly threads: number) {}

  get(circuit: string): Promise<Prover> {
    let prover = this.loaded.get(circuit);
    if (!prover) {
      const compiled = JSON.parse(readFileSync(`${process.env.CIRCUITS_DIR ?? `${REPO_ROOT}zk/circuits/target`}/${circuit}.json`, "utf8")) as CompiledCircuit;
      prover = Prover.create(compiled, this.threads);
      this.loaded.set(circuit, prover);
    }
    return prover;
  }

  async destroyAll(): Promise<void> {
    await Promise.all([...this.loaded.values()].map((p) => p.then((x) => x.destroy())));
    this.loaded.clear();
  }
}
