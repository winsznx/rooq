import { beforeAll, describe, expect, test } from "bun:test";
import { addressOf, deriveKeys, initCrypto, noteOutput, toHex32 } from "@rooq/private-sdk";
import { ServiceError } from "../../src/lib/errors";
import { FeeTable, serviceTokenValid, settleFee } from "../../src/lib/relay-fee";
import type { RelayCall } from "../../src/lib/relay-codec";

const DEPLOYMENT = 31337n << 160n;
const USDG = `0x${"11".repeat(20)}`;
const STOCK = `0x${"22".repeat(20)}`;

let relayer: ReturnType<typeof deriveKeys>;
let user: ReturnType<typeof deriveKeys>;

function feeNote(asset: string, value: bigint, to = relayer) {
  const n = noteOutput(DEPLOYMENT, BigInt(asset), value, 77n, addressOf(to));
  return { commitment: toHex32(n.commitment), ct: n.ct.map(toHex32) };
}

const call = (action: RelayCall["action"], ...fees: ReturnType<typeof feeNote>[]): RelayCall => {
  const args = action === "lockPair" ? ["0x01", { relayFee: fees[0] }, "0x02", { relayFee: fees[1] }] : ["0x01", { relayFee: fees[0] }];
  return { action, functionName: action, args, nullifiers: [] };
};

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error.reasonCode;
    throw error;
  }
  return "none";
};

describe("relay fee settlement (spec-fees.md section 5)", () => {
  beforeAll(async () => {
    await initCrypto();
    relayer = deriveKeys(0x7e1a1e4n);
    user = deriveKeys(0xa11cen);
  });

  test("an empty RELAYER_MIN_FEES is the testnet setting: every fee-carrying action is free and nothing is opened", () => {
    const fee = { keys: relayer, table: FeeTable.parse("") };
    expect(settleFee(call("lock", feeNote(USDG, 0n, user)), fee, DEPLOYMENT, false).settlement).toBe("free");
    expect(settleFee(call("lock", feeNote(USDG, 0n, user)), null, DEPLOYMENT, false).settlement).toBe("free");
  });

  test("a note that pays this relayer enough settles as paid; a zero note to self or a short one is refused by name", () => {
    const fee = { keys: relayer, table: FeeTable.parse(`${USDG}:500`) };
    expect(settleFee(call("release", feeNote(USDG, 500n)), fee, DEPLOYMENT, false).settlement).toBe("paid");
    expect(reason(() => settleFee(call("release", feeNote(USDG, 0n, user)), fee, DEPLOYMENT, false))).toBe("RELAYER_FEE_REQUIRED");
    expect(reason(() => settleFee(call("release", feeNote(USDG, 499n)), fee, DEPLOYMENT, false))).toBe("RELAYER_FEE_TOO_LOW");
    expect(reason(() => settleFee(call("release", feeNote(STOCK, 10_000n)), fee, DEPLOYMENT, false))).toBe("RELAYER_FEE_ASSET");
  });

  test("an action-specific minimum applies to that action only and wins over the general one", () => {
    const fee = { keys: relayer, table: FeeTable.parse(`release:${USDG}:500`) };
    expect(settleFee(call("lock", feeNote(USDG, 0n, user)), fee, DEPLOYMENT, false).settlement).toBe("free");
    expect(reason(() => settleFee(call("release", feeNote(USDG, 0n, user)), fee, DEPLOYMENT, false))).toBe("RELAYER_FEE_REQUIRED");
    const both = FeeTable.parse(`${USDG}:100,release:${USDG}:500`);
    expect(both.minimum("lock", BigInt(USDG))).toBe(100n);
    expect(both.minimum("release", BigInt(USDG))).toBe(500n);
  });

  test("lockPair owes the lock quote twice, paid by either or both halves", () => {
    const fee = { keys: relayer, table: FeeTable.parse(`lock:${USDG}:300`) };
    expect(settleFee(call("lockPair", feeNote(USDG, 600n), feeNote(USDG, 0n, user)), fee, DEPLOYMENT, false).settlement).toBe("paid");
    expect(reason(() => settleFee(call("lockPair", feeNote(USDG, 300n), feeNote(USDG, 0n, user)), fee, DEPLOYMENT, false))).toBe("RELAYER_FEE_TOO_LOW");
  });

  test("operator traffic with the service token is waived without opening anything", () => {
    const fee = { keys: relayer, table: FeeTable.parse(`${USDG}:500`) };
    expect(settleFee(call("lock", feeNote(USDG, 0n, user)), fee, DEPLOYMENT, true).settlement).toBe("waived");
    expect(serviceTokenValid("s3cret", "s3cret")).toBe(true);
    expect(serviceTokenValid("s3cret", "other!")).toBe(false);
    expect(serviceTokenValid(null, "s3cret")).toBe(false);
    expect(serviceTokenValid("s3cret", null)).toBe(false);
  });

  test("RELAYER_MIN_FEES refuses malformed entries and unknown actions", () => {
    expect(() => FeeTable.parse("nope")).toThrow("asset:amount");
    expect(() => FeeTable.parse(`transfer:${USDG}:1`)).toThrow("unknown action");
  });
});
