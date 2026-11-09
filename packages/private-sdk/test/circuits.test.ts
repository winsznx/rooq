import { Noir } from "@noir-lang/noir_js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addressOf, appendWitness, deriveKeys, initCrypto, KIND_DEPOSIT, MerkleTree, noteCommitment, noteInner,
  ownerNullifier, Prover, scanCreated, spendWitness, toHex32, type OwnedNote,
} from "../src";
import { circuit } from "./helpers";

const DEPLOYMENT = (46630n << 160n) | 0x1234n;
const USDG = 0x7e955252e15c84f5768b83c41a71f9eba181802fn;

let spendProver: Prover;

beforeAll(async () => {
  await initCrypto();
  spendProver = await Prover.create(circuit("spend"));
}, 120_000);

afterAll(async () => {
  await spendProver.destroy();
});

function funded(seed: bigint, values: bigint[]) {
  const keys = deriveKeys(seed);
  const tree = new MerkleTree();
  const notes: OwnedNote[] = values.map((value, i) => {
    const [rho, blind] = [BigInt(100 + i), BigInt(200 + i)];
    const cm = noteCommitment(DEPLOYMENT, USDG, value, noteInner(keys.owner, rho, blind));
    return { leafIndex: tree.insert(cm), asset: USDG, value, rho, blind, commitment: cm, nullifier: ownerNullifier(keys.nk, cm) };
  });
  return { keys, tree, notes };
}

describe("append circuit", () => {
  it("accepts a deposit batch and reports the root the SDK tree reaches", async () => {
    // #given two queued deposits on an empty tree
    const tree = new MerkleTree();
    const entries = [1n, 2n].map((k) => ({ kind: KIND_DEPOSIT, a: 1000n + k, b: USDG, c: 5_000_000n * k }));
    // #when
    const { inputs, newRoot } = appendWitness(tree, entries, DEPLOYMENT);
    const { witness } = await new Noir(circuit("append")).execute(inputs);
    // #then the circuit accepted and the tree moved
    expect([witness.length > 0, newRoot === new MerkleTree().root()]).toEqual([true, false]);
  });

  it("rejects a batch that claims a different deposited amount", async () => {
    // #given a valid witness whose public amount is then changed
    const { inputs } = appendWitness(new MerkleTree(), [{ kind: KIND_DEPOSIT, a: 7n, b: USDG, c: 10n }], DEPLOYMENT);
    (inputs.c as string[])[0] = toHex32(11n);
    // #when / #then
    await expect(new Noir(circuit("append")).execute(inputs)).rejects.toThrow();
  });
});

describe("spend circuit", () => {
  it("proves a private transfer with change that the recipient can find", async () => {
    // #given alice holds 600 and 400
    const { keys, tree, notes } = funded(1n, [600n, 400n]);
    const bob = deriveKeys(2n);
    // #when she pays bob 700 and keeps 300
    const w = spendWitness({
      keys, deployment: DEPLOYMENT, tree, asset: USDG, inputs: notes,
      outputs: [{ value: 700n, to: addressOf(bob) }, { value: 300n, to: addressOf(keys) }],
    });
    const proof = await spendProver.prove(w.inputs);
    const found = scanCreated(bob, DEPLOYMENT, [{
      firstLeafIndex: 2,
      commitments: w.publicInputs.commitments.map(BigInt),
      ciphertexts: w.publicInputs.ciphertexts.map((c) => c.map(BigInt)),
    }]);
    // #then the proof verifies, nothing public names the asset, and bob finds exactly his 700
    expect({
      verified: await spendProver.verify(proof),
      publicAsset: BigInt(w.publicInputs.publicAsset),
      bob: found.map((n) => n.value),
      root: BigInt(proof.publicInputs[0]!) === tree.root(),
    }).toEqual({ verified: true, publicAsset: 0n, bob: [700n], root: true });
  }, 120_000);

  it("reveals the asset only when value leaves the pool", () => {
    // #given / #when a withdrawal of 250 with a relayer fee of 5
    const { keys, tree, notes } = funded(3n, [300n]);
    const w = spendWitness({
      keys, deployment: DEPLOYMENT, tree, asset: USDG, inputs: notes,
      outputs: [{ value: 45n, to: addressOf(keys) }],
      withdraw: { amount: 250n, recipient: 0xbeefn }, relayer: { address: 0xfeen, fee: 5n },
    });
    // #then
    expect(BigInt(w.publicInputs.publicAsset)).toBe(USDG);
  });

  it("rejects a spend by a different key", async () => {
    // #given alice's notes and eve's key
    const { tree, notes } = funded(4n, [100n]);
    const eve = deriveKeys(5n);
    const w = spendWitness({ keys: eve, deployment: DEPLOYMENT, tree, asset: USDG, inputs: notes, outputs: [{ value: 100n, to: addressOf(eve) }] });
    // #when / #then: eve's owner tag does not open alice's commitment
    await expect(new Noir(circuit("spend")).execute(w.inputs)).rejects.toThrow();
  });

  it("rejects an output larger than the inputs", async () => {
    // #given a valid witness with the output value raised after the fact
    const { keys, tree, notes } = funded(6n, [100n]);
    const w = spendWitness({ keys, deployment: DEPLOYMENT, tree, asset: USDG, inputs: notes, outputs: [{ value: 100n, to: addressOf(keys) }] });
    ((w.inputs.outs as { value: string }[])[0]!).value = toHex32(101n);
    // #when / #then
    await expect(new Noir(circuit("spend")).execute(w.inputs)).rejects.toThrow();
  });

  it("rejects a public asset when nothing leaves the pool", async () => {
    // #given a private-only transfer that tries to publish the asset
    const { keys, tree, notes } = funded(7n, [100n]);
    const w = spendWitness({ keys, deployment: DEPLOYMENT, tree, asset: USDG, inputs: notes, outputs: [{ value: 100n, to: addressOf(keys) }] });
    w.inputs.public_asset = toHex32(USDG);
    // #when / #then
    await expect(new Noir(circuit("spend")).execute(w.inputs)).rejects.toThrow();
  });
});
