import { beforeAll, describe, expect, it } from "vitest";
import {
  addressOf, decrypt, deriveKeys, encrypt, hash, initCrypto, MerkleTree, noteCommitment, noteInner, randomField, T_NODE,
} from "../src";
import { contractEmptyRoot } from "./helpers";

beforeAll(async () => {
  await initCrypto();
});

describe("tree", () => {
  it("starts at the contract's EMPTY_ROOT", () => {
    // #given an empty depth-32 tree / #when / #then
    expect(new MerkleTree().root()).toBe(contractEmptyRoot());
  });

  it("returns a path that rebuilds the root for every inserted leaf", () => {
    // #given
    const t = new MerkleTree(4);
    const leaves = [11n, 22n, 33n, 44n, 55n];
    leaves.forEach((l) => t.insert(l));
    // #when each leaf's path is folded upward as the circuit does
    const fold = (leaf: bigint, index: number): bigint =>
      t.path(index).reduce((node, sib, level) => ((index >> level) & 1 ? hash([T_NODE, sib, node]) : hash([T_NODE, node, sib])), leaf);
    // #then every fold reaches the root
    expect(leaves.map((l, i) => fold(l, i) === t.root())).toEqual(leaves.map(() => true));
  });
});

describe("note encryption", () => {
  it("decrypts to the plaintext with the recipient key", () => {
    // #given
    const bob = deriveKeys(randomField());
    const pt = [0n, 7n, 1_000n, randomField(), randomField()];
    // #when
    const ct = encrypt(pt, bob.pk, randomField());
    // #then
    expect(decrypt(ct, bob.encSk)).toEqual(pt);
  });

  it("does not rebuild the commitment under another wallet's key", () => {
    // #given a note for bob
    const bob = deriveKeys(1n);
    const eve = deriveKeys(2n);
    const [rho, blind] = [randomField(), randomField()];
    const cm = noteCommitment(9n, 7n, 1_000n, noteInner(bob.owner, rho, blind));
    const ct = encrypt([0n, 7n, 1_000n, rho, blind], addressOf(bob).pk, randomField());
    // #when eve decrypts
    const [, asset, value, r, b] = decrypt(ct, eve.encSk) as [bigint, bigint, bigint, bigint, bigint];
    // #then the result does not open bob's commitment under eve's owner tag
    expect(noteCommitment(9n, asset, value, noteInner(eve.owner, r, b))).not.toBe(cm);
  });
});
