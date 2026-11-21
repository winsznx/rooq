import { parseAbi, type Hex } from "viem";
import { PRIVATE_DEPLOYMENT_PIN } from "@/lib/private/config";
import { checkNoteReceipt, parseNoteReceipt, type NoteReceipt, type QueueEntry, type ReceiptFailure } from "@/lib/private/receipt";
import { amountText, client, readToken } from "./inspect";

const POOL_QUEUE = parseAbi([
  "function queueLength() view returns (uint256)",
  "function queueEntry(uint256 i) view returns ((uint8 kind, bytes32 a, bytes32 b, bytes32 c))",
]);

export type CheckedReceipt =
  | { readonly ok: true; readonly leafIndex: number; readonly amount: string; readonly origin: "deposit" | "note" }
  | { readonly ok: false; readonly leafIndex: number | null; readonly reason: ReceiptFailure | "NOT_CONFIGURED" };

/** Takes a file saved from Private activity, or a single receipt, and returns the receipts it holds. */
export function receiptsIn(text: string): NoteReceipt[] | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const list = typeof body === "object" && body !== null && Array.isArray((body as { receipts?: unknown }).receipts) ? (body as { receipts: unknown[] }).receipts : [body];
  const parsed = list.map(parseNoteReceipt);
  return parsed.length > 0 && parsed.every((r) => r !== null) ? (parsed as NoteReceipt[]) : null;
}

/** Checks each receipt in this browser against ShieldedPool storage over the public RPC. Nothing is sent to Rooq. */
export async function checkReceipts(receipts: readonly NoteReceipt[]): Promise<CheckedReceipt[]> {
  const pin = PRIVATE_DEPLOYMENT_PIN;
  if (!pin) return receipts.map((r) => ({ ok: false, leafIndex: r.leafIndex, reason: "NOT_CONFIGURED" }));
  const sdk = await import("@rooq/private-sdk");
  await sdk.initCrypto();
  const rpc = client();
  const length = await rpc.readContract({ address: pin.pool, abi: POOL_QUEUE, functionName: "queueLength" });
  const readEntry = async (leafIndex: number): Promise<QueueEntry | null> => {
    if (BigInt(leafIndex) >= length) return null;
    const e = await rpc.readContract({ address: pin.pool, abi: POOL_QUEUE, functionName: "queueEntry", args: [BigInt(leafIndex)] });
    return { kind: e.kind, a: e.a as Hex, b: e.b as Hex, c: e.c as Hex };
  };
  return Promise.all(
    receipts.map(async (r): Promise<CheckedReceipt> => {
      const result = await checkNoteReceipt(r, { pin, commitmentOf: sdk.noteCommitment, readEntry });
      if (!result.ok) return { ok: false, leafIndex: r.leafIndex, reason: result.reason };
      return { ok: true, leafIndex: result.leafIndex, amount: amountText(result.value, await readToken(rpc, result.asset)), origin: result.origin };
    }),
  );
}
