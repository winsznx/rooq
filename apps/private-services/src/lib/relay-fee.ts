import { timingSafeEqual } from "node:crypto";
import { scanCreated, type OwnedNote, type WalletKeys } from "@rooq/private-sdk";
import { isAddress } from "viem";
import { ServiceError } from "./errors";
import { feeOutputOf, isRelayAction, type RelayAction, type RelayCall } from "./relay-codec";

/**
 * Minimum fee per (action, asset), from RELAYER_MIN_FEES. An `asset:amount` entry applies to every action with a fee output,
 * an `action:asset:amount` entry to that action only and wins over the first kind. Empty means every quote is zero, which is
 * the testnet setting: wallets send a zero fee note to themselves and nothing is decrypted.
 */
export class FeeTable {
  private constructor(
    private readonly all: ReadonlyMap<bigint, bigint>,
    private readonly perAction: ReadonlyMap<RelayAction, ReadonlyMap<bigint, bigint>>,
  ) {}

  static parse(raw: string): FeeTable {
    const all = new Map<bigint, bigint>();
    const perAction = new Map<RelayAction, Map<bigint, bigint>>();
    for (const part of raw.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
      const fields = part.split(":");
      const [action, asset, amount] = fields.length === 3 ? fields : [undefined, fields[0], fields[1]];
      if (fields.length < 2 || fields.length > 3 || !asset || !amount || !isAddress(asset) || !/^\d+$/.test(amount)) throw new Error("RELAYER_MIN_FEES entries are asset:amount or action:asset:amount");
      if (action === undefined) {
        all.set(BigInt(asset), BigInt(amount));
        continue;
      }
      if (!isRelayAction(action)) throw new Error(`RELAYER_MIN_FEES names an unknown action: ${action}`);
      const table = perAction.get(action) ?? new Map<bigint, bigint>();
      table.set(BigInt(asset), BigInt(amount));
      perAction.set(action, table);
    }
    return new FeeTable(all, perAction);
  }

  /** Whether any fee is configured for this action. Until one is, its fee note is never opened. */
  charges(action: RelayAction): boolean {
    return this.all.size > 0 || (this.perAction.get(feeAction(action))?.size ?? 0) > 0;
  }

  /** The minimum for one action in one asset, or undefined when this relayer takes no fee in that asset for it. */
  minimum(action: RelayAction, asset: bigint): bigint | undefined {
    return this.perAction.get(feeAction(action))?.get(asset) ?? this.all.get(asset);
  }

  quotes(): { action: RelayAction | "*"; asset: string; amount: bigint }[] {
    const hex = (a: bigint): string => `0x${a.toString(16).padStart(40, "0")}`;
    return [
      ...[...this.all].map(([asset, amount]) => ({ action: "*" as const, asset: hex(asset), amount })),
      ...[...this.perAction].flatMap(([action, t]) => [...t].map(([asset, amount]) => ({ action, asset: hex(asset), amount }))),
    ];
  }
}

/** lockPair is two locks: priced as `lock`, owed once per half. */
const feeAction = (action: RelayAction): RelayAction => (action === "lockPair" ? "lock" : action);
const feeCount = (action: RelayAction): bigint => (action === "lockPair" ? 2n : 1n);

export type FeeSettlement = "paid" | "waived" | "free";

/**
 * How a request settles with this relayer. "free" draws on the hourly allowance; "paid" and "waived" don't. A paid request's
 * fee note must open with the relayer's fee key, rebuild its commitment, and cover the quote: the proof fixes the note, so
 * inclusion pays the relayer. Nothing here is learned that the chain won't show, except the fee asset and amount (D-05).
 */
export function settleFee(call: RelayCall, fee: { readonly keys: WalletKeys; readonly table: FeeTable } | null, deployment: bigint, waived: boolean): { settlement: FeeSettlement; notes: OwnedNote[] } {
  if (waived) return { settlement: "waived", notes: [] };
  const outputs = feeOutputOf(call);
  if (!fee || outputs.length === 0 || !fee.table.charges(call.action)) return { settlement: "free", notes: [] };
  const notes = scanCreated(fee.keys, deployment, outputs.map((o) => ({ firstLeafIndex: 0, commitments: [BigInt(o.commitment)], ciphertexts: [o.ct.map(BigInt)] })));
  if (notes.length === 0) {
    throw new ServiceError(402, "RELAYER_FEE_REQUIRED", "The relay fee output must be a note to this relayer's fee address.", false, { feeAddress: { auth: fee.keys.auth, pk: fee.keys.pk } });
  }
  const asset = notes[0]!.asset;
  const minimum = fee.table.minimum(call.action, asset);
  if (minimum === undefined || notes.some((n) => n.asset !== asset)) throw new ServiceError(402, "RELAYER_FEE_ASSET", "This relayer does not take fees in that asset.", false);
  if (notes.reduce((sum, n) => sum + n.value, 0n) < minimum * feeCount(call.action)) throw new ServiceError(402, "RELAYER_FEE_TOO_LOW", "The fee note is below this relayer's minimum.", false);
  return { settlement: "paid", notes };
}

/** Constant-time comparison of a presented service token against the configured one. */
export function serviceTokenValid(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
