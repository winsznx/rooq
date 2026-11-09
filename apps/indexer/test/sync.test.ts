import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { checkLinkage, commonAncestor } from "../src/sync";
import type { BlockHeader } from "../src/store";

const h = (n: number, fork = "a"): Hex => `0x${fork.repeat(2)}${n.toString(16).padStart(62, "0")}`;
const header = (n: number, fork = "a", parentFork = fork): BlockHeader => ({ number: BigInt(n), hash: h(n, fork), parentHash: h(n - 1, parentFork), timestamp: BigInt(n) });

describe("checkLinkage", () => {
  test("accepts a range that extends the cursor block by block", () => {
    // #given a cursor at 10 and headers 11..13 on the same fork
    // #when / #then
    expect(checkLinkage({ block: 10n, hash: h(10) }, [header(11), header(12), header(13)])).toEqual({ ok: true });
  });

  test("reports a reorg when the first header's parent is not the cursor", () => {
    // #given headers 11..12 built on a different block 10
    // #when / #then
    expect(checkLinkage({ block: 10n, hash: h(10) }, [header(11, "b"), header(12, "b")])).toEqual({ ok: false, reason: "parent-mismatch" });
  });

  test("asks for a refetch when the chain changed in the middle of the range", () => {
    // #given 12 does not point at the 11 that was fetched
    // #when / #then
    expect(checkLinkage({ block: 10n, hash: h(10) }, [header(11), header(12, "b", "b")])).toEqual({ ok: false, reason: "internal" });
  });

  test("rejects a range that does not start right after the cursor", () => {
    expect(checkLinkage({ block: 10n, hash: h(10) }, [header(12)])).toEqual({ ok: false, reason: "gap" });
  });

  test("accepts the first range when there is no cursor yet", () => {
    expect(checkLinkage(null, [header(0), header(1)])).toEqual({ ok: true });
  });
});

describe("commonAncestor", () => {
  test("returns the highest height where stored and node hashes agree", () => {
    // #given stored 8..12 on fork a, the node has fork b above 9
    const stored = new Map([8, 9, 10, 11, 12].map((n) => [BigInt(n), h(n)] as const));
    const chain = new Map([8, 9, 10, 11, 12].map((n) => [BigInt(n), n > 9 ? h(n, "b") : h(n)] as const));
    // #when / #then
    expect(commonAncestor(stored, chain)).toBe(9n);
  });

  test("returns null when no supplied height agrees", () => {
    const stored = new Map([[5n, h(5)]]);
    const chain = new Map([[5n, h(5, "b")]]);
    expect(commonAncestor(stored, chain)).toBeNull();
  });
});
