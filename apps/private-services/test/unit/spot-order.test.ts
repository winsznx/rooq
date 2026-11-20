import { beforeAll, describe, expect, test } from "bun:test";
import { initCrypto, ROLE_LP, ROLE_SWAP, type HeldLock, type LockRecord } from "@rooq/private-sdk";
import { orderSpotWork } from "../../src/lib/spot-exec";

const DEPLOYMENT = 7n;
const POOL = 1n;

function lock(leafIndex: number, over: Partial<LockRecord>): HeldLock {
  const record: LockRecord = {
    asset: 1n, amount: 1_000n, ownerAuth: 5n, ownerX: 6n, ownerY: 7n, role: ROLE_SWAP, market: POOL, t2: 0n, t3: 1n, t4: 0n,
    expiry: 10_000n, recNonce: BigInt(leafIndex + 1), blind: 9n, ...over,
  };
  return { record, leafIndex };
}

/** Side 0 carries the band's low edge and side 1 its high edge, so the two halves never share t3. */
const lpLock = (leafIndex: number, side: bigint, link = 42n, ownerAuth = 5n): HeldLock => lock(leafIndex, { role: ROLE_LP, t2: side, t3: side === 0n ? 90n : 110n, t4: link, ownerAuth });
const swap = (leafIndex: number, pool = POOL): HeldLock => lock(leafIndex, { role: ROLE_SWAP, market: pool });

describe("spot work ordering (audit #8)", () => {
  beforeAll(() => initCrypto());

  test("an adjacent LP pair runs as one add at its first leaf, in tree order with swaps", () => {
    const { work, notAdjacent } = orderSpotWork([swap(30), lpLock(9, 0n), lpLock(10, 1n), swap(5)], [], 100, DEPLOYMENT);
    expect(work.map((w) => `${w.kind}:${w.leaf}`)).toEqual(["swap:5", "add:9", "swap:30"]);
    expect(notAdjacent).toEqual([]);
  });

  test("LP locks with different bounds still pair by link and owner", () => {
    const { work } = orderSpotWork([lpLock(20, 0n, 7n), lpLock(21, 1n, 7n)], [], 100, DEPLOYMENT);
    expect(work).toHaveLength(1);
    expect(work[0]!.kind).toBe("add");
  });

  test("an LP pair that isn't adjacent is never planned and is reported, and nothing waits for it", () => {
    const { work, notAdjacent } = orderSpotWork([lpLock(9, 0n), swap(19), lpLock(49, 1n)], [], 100, DEPLOYMENT);
    expect(work.map((w) => `${w.kind}:${w.leaf}`)).toEqual(["swap:19"]);
    expect(notAdjacent).toEqual([9]);
  });

  test("a lone LP lock holds nothing back and is not reported", () => {
    const { work, notAdjacent } = orderSpotWork([lpLock(9, 0n), swap(19)], [], 100, DEPLOYMENT);
    expect(work.map((w) => w.leaf)).toEqual([19]);
    expect(notAdjacent).toEqual([]);
  });

  test("locks of another link or owner don't pair", () => {
    expect(orderSpotWork([lpLock(9, 0n, 1n), lpLock(10, 1n, 2n)], [], 100, DEPLOYMENT).work).toEqual([]);
    expect(orderSpotWork([lpLock(9, 0n, 1n, 5n), lpLock(10, 1n, 1n, 6n)], [], 100, DEPLOYMENT).work).toEqual([]);
  });

  test("intents not yet in the tree are left out", () => {
    const { work } = orderSpotWork([swap(150), lpLock(9, 0n), lpLock(10, 1n), lpLock(99, 0n, 3n), lpLock(100, 1n, 3n)], [], 100, DEPLOYMENT);
    expect(work.map((w) => `${w.kind}:${w.leaf}`)).toEqual(["add:9"]);
  });
});
