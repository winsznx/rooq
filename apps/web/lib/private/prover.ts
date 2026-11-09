import { Prover, type CompiledCircuit, type Proof } from "@rooq/private-sdk";
import type { InputValue } from "@rooq/private-sdk";

type Inputs = { [k: string]: InputValue };

const CACHE_SIZE = 2;
const MAX_THREADS = 4;
const PROOF_TIMEOUT_MS = 300_000;

export type WalletCircuit = "spend" | "lock" | "release" | "close_pair" | "pair_update" | "exit_request" | "redeem_claim" | "lp_set";

/** Serve bb.js's CRS from this origin, so proving makes no third-party request and works if Aztec's CDN doesn't. */
export function installCrsMirror(): void {
  const real = self.fetch.bind(self);
  self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = /^https:\/\/crs\.aztec[^/]+\/(.+)$/.exec(url);
    if (!m) return real(input, init);
    const range = new Headers(init?.headers).get("range");
    return real(`/proving/${m[1]}`).then(async (res) => {
      if (!res.ok) throw new Error(`proving asset ${m[1]} is missing (${res.status})`);
      const body = await res.arrayBuffer();
      const end = range ? Number(range.split("-")[1]) + 1 : body.byteLength;
      return new Response(body.slice(0, end), { status: 200 });
    });
  }) as typeof fetch;
}

const provers = new Map<string, Prover>();
let chain: Promise<unknown> = Promise.resolve();

function threads(): number {
  if (!self.crossOriginIsolated) return 1;
  return Math.max(1, Math.min(navigator.hardwareConcurrency - 1, MAX_THREADS));
}

async function get(circuit: WalletCircuit): Promise<Prover> {
  const held = provers.get(circuit);
  if (held) {
    provers.delete(circuit);
    provers.set(circuit, held);
    return held;
  }
  const res = await fetch(`/proving/${circuit}.json`);
  if (!res.ok) throw new Error(`proving asset ${circuit} is missing (${res.status})`);
  const prover = await Prover.create((await res.json()) as CompiledCircuit, threads());
  provers.set(circuit, prover);
  while (provers.size > CACHE_SIZE) {
    const oldest = provers.keys().next().value as string;
    const stale = provers.get(oldest)!;
    provers.delete(oldest);
    await stale.destroy();
  }
  return prover;
}

export class ProofFailed extends Error {
  constructor(readonly reason: "PROOF_TIMEOUT" | "PROOF_CONSTRAINT", message: string) {
    super(message);
  }
}

/** One proof at a time. A constraint failure names the rule the input broke, before anything is sent. */
export function prove(circuit: WalletCircuit, inputs: Inputs): Promise<Proof> {
  const run = chain.then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProofFailed("PROOF_TIMEOUT", "The proof didn't finish in 5 minutes on this device.")), PROOF_TIMEOUT_MS);
    });
    try {
      return await Promise.race([(await get(circuit)).prove(inputs), timeout]);
    } catch (error) {
      if (error instanceof ProofFailed) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/Circuit execution failed|Cannot satisfy constraint|assert/i.test(message)) throw new ProofFailed("PROOF_CONSTRAINT", message);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

export async function destroyProvers(): Promise<void> {
  const all = [...provers.values()];
  provers.clear();
  await Promise.all(all.map((p) => p.destroy()));
}
