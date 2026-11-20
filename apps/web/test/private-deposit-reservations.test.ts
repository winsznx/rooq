import { describe, expect, it } from "vitest";
import { DepositReservations, reserveUnused, type ReceiptStatus } from "../lib/private/deposit-reservations";

const GAP = 20;
const HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const noReceipt = async (): Promise<ReceiptStatus> => null;

describe("deposit index reservations (audit finding 3)", () => {
  it("keeps an index whose shield was broadcast but never confirmed", () => {
    // #given a shield whose receipt wait timed out
    const r = new DepositReservations(GAP);
    const k = r.reserve(0)!;
    r.sent(k, HASH);
    r.finished(k);
    // #when the person shields again before the chain shows the first one
    // #then the retry gets a fresh opening
    expect(r.reserve(0)).toBe(k + 1);
  });

  it("keeps a reservation across a reload", async () => {
    // #given a reservation stored before the wallet signed
    const before = new DepositReservations(GAP);
    const k = before.reserve(3)!;
    // #when the page reloads and the chain still hasn't indexed it
    const after = new DepositReservations(GAP, JSON.parse(JSON.stringify(before.list())) as ReturnType<DepositReservations["list"]>);
    await after.settle(3, noReceipt);
    // #then the index isn't handed out again
    expect(after.reserve(3)).toBe(k + 1);
  });

  it("frees an index whose shield never left the wallet", () => {
    const r = new DepositReservations(GAP);
    const k = r.reserve(0)!;
    r.finished(k);
    expect(r.reserve(0)).toBe(k);
  });

  it("frees an index once its transaction reverted", async () => {
    const r = new DepositReservations(GAP);
    const k = r.reserve(0)!;
    r.sent(k, HASH);
    r.finished(k);
    expect(await r.settle(0, async () => "reverted")).toBe(true);
    expect(r.reserve(0)).toBe(k);
  });

  it("keeps an index whose transaction succeeded until the chain consumes it", async () => {
    const r = new DepositReservations(GAP);
    const k = r.reserve(0)!;
    r.sent(k, HASH);
    await r.settle(0, async () => "success");
    expect(r.list()).toEqual([{ index: k, hash: HASH }]);
    await r.settle(k + 1, async () => "success");
    expect(r.list()).toEqual([]);
  });

  it("refuses an index the scanner would never reach", () => {
    const r = new DepositReservations(GAP);
    for (let i = 0; i < GAP; i++) r.reserve(0);
    expect(r.reserve(0)).toBeNull();
  });
});

describe("deposit index reuse (ShieldedPool InnerReused)", () => {
  it("moves to the next index when the pool already holds this one's opening", async () => {
    // #given index 0's inner already used on chain by another tab
    const r = new DepositReservations(GAP);
    // #when the wallet reserves for a new shield
    const k = await reserveUnused(r, 0, async (i) => i === 0);
    // #then it skips to index 1
    expect(k).toBe(1);
  });

  it("never hands a taken index back, even after the wallet finishes", async () => {
    const r = new DepositReservations(GAP);
    await reserveUnused(r, 0, async (i) => i === 0);
    r.finished(0);
    expect(r.reserve(0)).toBe(2);
  });

  it("keeps a taken index across a reload until the scanner passes it", async () => {
    const r = new DepositReservations(GAP);
    await reserveUnused(r, 0, async (i) => i === 0);
    const after = new DepositReservations(GAP, JSON.parse(JSON.stringify(r.list())) as ReturnType<DepositReservations["list"]>);
    await after.settle(1, noReceipt);
    expect(after.list()).toEqual([{ index: 1, hash: null }]);
  });

  it("gives the index back when the chain can't be asked", async () => {
    const r = new DepositReservations(GAP);
    await expect(reserveUnused(r, 0, async () => { throw new Error("rpc down"); })).rejects.toThrow("rpc down");
    expect(r.list()).toEqual([]);
  });

  it("returns null when every index in the scanner's gap is taken", async () => {
    expect(await reserveUnused(new DepositReservations(GAP), 0, async () => true)).toBeNull();
  });
});
