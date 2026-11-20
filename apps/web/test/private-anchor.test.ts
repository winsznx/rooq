import { describe, expect, it } from "vitest";
import { checkRows, highestPending, rootOnChain, type LeafSource } from "../lib/private/anchor";

const tree = (leaves: bigint[]): LeafSource => ({ size: leaves.length, leaf: (i) => leaves[i] });
const row = (leafIndex: number, commitment: bigint) => ({ leafIndex, commitment });

describe("read API data anchored to the chain (audit finding 28)", () => {
  it("rejects a root the pool never recorded", async () => {
    // #given a read API that serves a self-consistent fabricated tree
    // #when the pool's rootSeqOf has no entry for that root
    // #then the wallet refuses it
    expect(await rootOnChain(async () => 0n, 1, 0)).toBe(false);
  });

  it("accepts a root the pool recorded, even after the RPC catches up", async () => {
    const answers = [0n, 7n];
    expect(await rootOnChain(async () => answers.shift() ?? 0n, 2, 0)).toBe(true);
  });

  it("flags a record whose commitment isn't the leaf at its index", () => {
    const rows = [row(0, 10n), row(1, 999n), row(2, 12n)];
    const { bad } = checkRows(rows, 0, tree([10n, 11n, 12n]), (r) => r.commitment);
    expect(bad).toEqual(row(1, 999n));
  });

  it("checks rows once and leaves those past the tree for later", () => {
    const rows = [row(0, 10n), row(1, 11n), row(5, 15n)];
    expect(checkRows(rows, 0, tree([10n, 11n, 12n]), (r) => r.commitment)).toEqual({ next: 2, bad: null });
  });

  it("reports the highest pending leaf for the queue length check", () => {
    expect(highestPending([row(0, 1n), row(4, 1n), row(9, 1n)], 3)).toBe(9);
  });
});
