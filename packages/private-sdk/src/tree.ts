import { T_NODE, TREE_DEPTH } from "./constants";
import { hash } from "./crypto";

/** Append-only Poseidon2 Merkle tree mirroring the on-chain root (ADR-P02 section 3). */
export class MerkleTree {
  private readonly zeros: bigint[];
  private readonly layers: bigint[][];

  constructor(readonly depth: number = TREE_DEPTH) {
    this.zeros = [0n];
    for (let i = 0; i < depth; i++) this.zeros.push(hash([T_NODE, this.zeros[i]!, this.zeros[i]!]));
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }

  get size(): number {
    return this.layers[0]!.length;
  }

  root(): bigint {
    return this.layers[this.depth]![0] ?? this.zeros[this.depth]!;
  }

  insert(leaf: bigint): number {
    const index = this.size;
    if (index >= 2 ** this.depth) throw new RangeError("tree full");
    this.layers[0]!.push(leaf);
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const parent = i >> 1;
      const left = this.node(level, parent * 2);
      const right = this.node(level, parent * 2 + 1);
      this.layers[level + 1]![parent] = hash([T_NODE, left, right]);
      i = parent;
    }
    return index;
  }

  /** Siblings from leaf to root for `index` (which may be the next empty slot). */
  path(index: number): bigint[] {
    const out: bigint[] = [];
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      out.push(this.node(level, i ^ 1));
      i >>= 1;
    }
    return out;
  }

  leaf(index: number): bigint | undefined {
    return this.layers[0]![index];
  }

  clone(): MerkleTree {
    const t = new MerkleTree(this.depth);
    this.layers.forEach((l, i) => t.layers[i]!.push(...l));
    return t;
  }

  private node(level: number, index: number): bigint {
    return this.layers[level]![index] ?? this.zeros[level]!;
  }
}
