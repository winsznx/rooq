import { initCrypto, noteCommitment, noteInner, randomField } from "@rooq/private-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { TESTNET_PRIVATE_DEPLOYMENT, TESTNET_PRIVATE_DEPLOYMENT_M36 as PIN } from "../lib/private/deployment-pin";
import { checkNoteReceipt, noteReceipt, parseNoteReceipt, type NoteReceipt, type QueueEntry } from "../lib/private/receipt";

const USDG = BigInt(PIN.asset);
const hex32 = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}` as const;
const ZERO = hex32(0n);

function depsWith(entries: Record<number, QueueEntry>) {
  return { pin: PIN, commitmentOf: noteCommitment, readEntry: async (i: number) => entries[i] ?? null };
}

describe("verifiable note receipts", () => {
  let inner: bigint;
  let receipt: NoteReceipt;
  let commitment: bigint;

  beforeAll(async () => {
    await initCrypto();
    inner = noteInner(randomField(), randomField(), randomField());
    receipt = noteReceipt({ leafIndex: 42, asset: USDG, value: 5_000_000n, inner }, PIN);
    commitment = noteCommitment(PIN.deploymentId, USDG, 5_000_000n, inner);
  });

  it("round-trips through JSON and the strict parser", () => {
    expect(parseNoteReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it("rejects a file that isn't a receipt", () => {
    expect([parseNoteReceipt(null), parseNoteReceipt({ ...receipt, version: 2 }), parseNoteReceipt({ ...receipt, value: "-1" }), parseNoteReceipt({ ...receipt, inner: "secret" })]).toEqual([null, null, null, null]);
  });

  it("confirms a note leaf whose stored commitment matches the opening", async () => {
    // #given the pool stored this note's commitment at leaf 42
    const result = await checkNoteReceipt(receipt, depsWith({ 42: { kind: 2, a: hex32(commitment), b: ZERO, c: ZERO } }));
    // #then the receipt checks out as a created note
    expect(result).toEqual({ ok: true, asset: receipt.asset, value: 5_000_000n, leafIndex: 42, origin: "note" });
  });

  it("confirms a deposit leaf from the stored inner, asset and amount", async () => {
    const result = await checkNoteReceipt(receipt, depsWith({ 42: { kind: 1, a: hex32(inner), b: hex32(USDG), c: hex32(5_000_000n) } }));
    expect(result).toMatchObject({ ok: true, origin: "deposit" });
  });

  it("refuses an inflated amount", async () => {
    // #given someone edits the value in a real receipt
    const edited = { ...receipt, value: "50000000" };
    // #then neither leaf kind accepts it
    const asNote = await checkNoteReceipt(edited, depsWith({ 42: { kind: 2, a: hex32(commitment), b: ZERO, c: ZERO } }));
    const asDeposit = await checkNoteReceipt(edited, depsWith({ 42: { kind: 1, a: hex32(inner), b: hex32(USDG), c: hex32(5_000_000n) } }));
    expect([asNote, asDeposit]).toEqual([{ ok: false, reason: "MISMATCH" }, { ok: false, reason: "MISMATCH" }]);
  });

  it("refuses a receipt pointed at another leaf or a leaf that doesn't exist", async () => {
    const other = await checkNoteReceipt({ ...receipt, leafIndex: 7 }, depsWith({ 7: { kind: 2, a: hex32(commitment + 1n), b: ZERO, c: ZERO } }));
    const missing = await checkNoteReceipt(receipt, depsWith({}));
    expect([other, missing]).toEqual([{ ok: false, reason: "MISMATCH" }, { ok: false, reason: "NO_SUCH_LEAF" }]);
  });

  it("refuses a receipt from another deployment without reading the chain", async () => {
    const old = noteReceipt({ leafIndex: 42, asset: USDG, value: 5_000_000n, inner }, TESTNET_PRIVATE_DEPLOYMENT);
    const result = await checkNoteReceipt(old, { ...depsWith({}), readEntry: () => Promise.reject(new Error("must not read")) });
    expect(result).toEqual({ ok: false, reason: "OTHER_DEPLOYMENT" });
  });
});
