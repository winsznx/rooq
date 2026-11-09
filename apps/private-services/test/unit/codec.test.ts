import { describe, expect, test } from "bun:test";
import { parseRelayRequest } from "../../src/lib/relay-codec";
import { FIELD } from "@rooq/private-sdk";

const h = (x: bigint): string => `0x${x.toString(16).padStart(64, "0")}`;
const noteCt = Array.from({ length: 7 }, () => h(1n));
const lock = {
  root: h(1n), nullifiers: [h(2n), h(3n)], changeCommitment: h(4n), lockCommitment: h(5n), changeCt: noteCt,
  ownerCt: Array.from({ length: 15 }, () => h(1n)), coordinatorCt: Array.from({ length: 15 }, () => h(1n)),
  riskCt: [Array.from({ length: 15 }, () => h(1n)), Array.from({ length: 15 }, () => h(1n))],
};

describe("relay codec", () => {
  test("accepts an exact lock request", () => {
    const call = parseRelayRequest("lock", { proof: "0x01ab", publicInputs: lock });
    expect(call.functionName).toBe("lock");
    expect([...call.nullifiers]).toEqual([h(2n), h(3n)] as typeof call.nullifiers[number][]);
  });

  test("refuses a non-canonical field element", () => {
    expect(() => parseRelayRequest("lock", { proof: "0x01", publicInputs: { ...lock, root: h(FIELD) } })).toThrow("canonical");
  });

  test("refuses a short ciphertext", () => {
    expect(() => parseRelayRequest("lock", { proof: "0x01", publicInputs: { ...lock, changeCt: noteCt.slice(1) } })).toThrow("array of 7");
  });

  test("refuses an unknown field and an odd-length proof", () => {
    expect(() => parseRelayRequest("lock", { proof: "0x01", publicInputs: { ...lock, extra: h(1n) } })).toThrow("not a known field");
    expect(() => parseRelayRequest("lock", { proof: "0x123", publicInputs: lock })).toThrow("hex bytes");
  });
});
