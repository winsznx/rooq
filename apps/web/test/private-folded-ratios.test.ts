import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { FoldedRatios, type FoldedReader } from "../lib/private/folded-ratios";

const delta = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

/** A chain with two markets: market 1 has folded deltas 0..2 of 4, market 2 has folded delta 0 of 1. */
function chain(): { reader: FoldedReader; calls: string[] } {
  const deltas = new Map<bigint, Hex[]>([[1n, [delta(10), delta(11), delta(12), delta(13)]], [2n, [delta(20)]]]);
  const consumed = new Map<bigint, bigint>([[1n, 3n], [2n, 1n]]);
  const ratios = new Map<string, bigint>([[delta(10), 1n], [delta(11), 5_000n], [delta(12), 9_000n], [delta(20), 7n]]);
  const calls: string[] = [];
  return {
    calls,
    reader: {
      consumed: async (m) => {
        calls.push(`consumed:${m}`);
        return consumed.get(m)!;
      },
      oiDeltas: async (m, indices) => {
        calls.push(`oiDeltas:${m}:${indices.join(",")}`);
        return indices.map((i) => deltas.get(m)![Number(i)]!);
      },
      ratiosPlusOne: async (ds) => {
        calls.push(`ratios:${ds.join(",")}`);
        return ds.map((d) => ratios.get(d) ?? 0n);
      },
    },
  };
}

const MARKETS = [{ id: 1n, stamp: "a" }, { id: 2n, stamp: "a" }];

describe("folded claim ratios (audit finding 10)", () => {
  it("sends the same RPC reads whichever claim the wallet holds", async () => {
    // #given two wallets holding claims on different liquidated pairs
    const a = chain();
    const b = chain();
    const holderA = new FoldedRatios();
    const holderB = new FoldedRatios();
    // #when each refreshes and looks up its own claim
    await holderA.refresh(MARKETS, a.reader);
    await holderB.refresh(MARKETS, b.reader);
    holderA.get(delta(11));
    holderB.get(delta(20));
    // #then the RPC saw identical requests and never a request built from one claim
    expect(a.calls).toEqual(b.calls);
  });

  it("returns the folded ratio, and null for a delta not folded yet", async () => {
    const { reader } = chain();
    const f = new FoldedRatios();
    await f.refresh(MARKETS, reader);
    expect([f.get(delta(11)), f.get(delta(10)), f.get(delta(13))]).toEqual([4_999n, 0n, null]);
  });

  it("reads only new deltas, and only for a market whose funding moved", async () => {
    const { reader, calls } = chain();
    const f = new FoldedRatios();
    await f.refresh(MARKETS, reader);
    calls.length = 0;
    await f.refresh([{ id: 1n, stamp: "b" }, { id: 2n, stamp: "a" }], reader);
    expect(calls).toEqual(["consumed:1"]);
  });
});

describe("folded ratios with a lagging RPC backend (re-audit)", () => {
  it("re-reads a consumed delta whose ratio read as 0, so the claim turns redeemable once the backend catches up", async () => {
    // #given a backend that returns 0 for delta 0 on the first read
    let consumed = 1n;
    let lagging = true;
    const reader: FoldedReader = {
      consumed: async () => consumed,
      oiDeltas: async (_m, idx) => idx.map((i) => delta(100 + Number(i))),
      ratiosPlusOne: async (ds) => ds.map((x) => (x === delta(100) && lagging ? 0n : 5n)),
    };
    const f = new FoldedRatios();
    await f.refresh([{ id: 1n, stamp: "e1" }], reader);
    expect(f.get(delta(100))).toBeNull();
    // #when the backend catches up, with or without a new epoch
    lagging = false;
    await f.refresh([{ id: 1n, stamp: "e1" }], reader);
    expect(f.get(delta(100))).toBe(4n);
    consumed = 2n;
    await f.refresh([{ id: 1n, stamp: "e2" }], reader);
    // #then both deltas read
    expect([f.get(delta(100)), f.get(delta(101))]).toEqual([4n, 4n]);
  });

  it("never moves past a zero inside a chunk, and keeps the deltas before it", async () => {
    const reads: string[] = [];
    let lagging = true;
    const reader: FoldedReader = {
      consumed: async () => 3n,
      oiDeltas: async (_m, idx) => idx.map((i) => delta(200 + Number(i))),
      ratiosPlusOne: async (ds) => {
        reads.push(ds.join(","));
        return ds.map((x) => (x === delta(201) && lagging ? 0n : 9n));
      },
    };
    const f = new FoldedRatios();
    await f.refresh([{ id: 1n, stamp: "a" }], reader);
    expect([f.get(delta(200)), f.get(delta(201)), f.get(delta(202))]).toEqual([8n, null, null]);
    lagging = false;
    await f.refresh([{ id: 1n, stamp: "a" }], reader);
    expect([f.get(delta(201)), f.get(delta(202))]).toEqual([8n, 8n]);
    expect(reads[1]).toBe(`${delta(201)},${delta(202)}`);
  });
});
