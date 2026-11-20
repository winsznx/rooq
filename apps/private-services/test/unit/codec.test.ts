import { describe, expect, test } from "bun:test";
import { feeOutputOf, parseRelayRequest, serviceTokenTransportAllowed } from "../../src/lib/relay-codec";
import { FIELD } from "@rooq/private-sdk";

const h = (x: bigint): string => `0x${x.toString(16).padStart(64, "0")}`;
const noteCt = Array.from({ length: 7 }, () => h(1n));
const lock = {
  root: h(1n), nullifiers: [h(2n), h(3n)], changeCommitment: h(4n), lockCommitment: h(5n), changeCt: noteCt,
  ownerCt: Array.from({ length: 15 }, () => h(1n)), coordinatorCt: Array.from({ length: 15 }, () => h(1n)),
  riskCt: [Array.from({ length: 15 }, () => h(1n)), Array.from({ length: 15 }, () => h(1n))],
  asOf: "1000", relayFee: { commitment: h(6n), ct: noteCt },
};
const lock2 = { ...lock, nullifiers: [h(7n), h(8n)], relayFee: { commitment: h(9n), ct: noteCt } };

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

  test("a lock without asOf or a relay fee output is refused", () => {
    const { relayFee: _fee, ...noFee } = lock;
    expect(() => parseRelayRequest("lock", { proof: "0x01", publicInputs: noFee })).toThrow("relayFee");
  });

  test("lockPair carries two proofs and both halves, and reports all four nullifiers", () => {
    const call = parseRelayRequest("lockPair", { proof: ["0x01ab", "0x02cd"], publicInputs: [lock, lock2] });
    expect(call.functionName).toBe("lockPair");
    expect(call.args).toHaveLength(4);
    expect(call.args[0]).toBe("0x01ab");
    expect(call.args[2]).toBe("0x02cd");
    expect([...call.nullifiers]).toEqual([h(2n), h(3n), h(7n), h(8n)] as typeof call.nullifiers[number][]);
    expect(() => parseRelayRequest("lockPair", { proof: "0x01ab", publicInputs: [lock, lock2] })).toThrow("array of 2");
    expect(() => parseRelayRequest("lockPair", { proof: ["0x01", "0x02"], publicInputs: [lock] })).toThrow("array of 2");
  });

  test("feeOutputOf: the relay fee note per action, a spend's third output, nothing for unpaid actions", () => {
    expect(feeOutputOf(parseRelayRequest("lock", { proof: "0x01", publicInputs: lock })).map((o) => o.commitment)).toEqual([h(6n)] as `0x${string}`[]);
    expect(feeOutputOf(parseRelayRequest("lockPair", { proof: ["0x01", "0x02"], publicInputs: [lock, lock2] })).map((o) => o.commitment)).toEqual([h(6n), h(9n)] as `0x${string}`[]);
    const release = { root: h(1n), nullifier: h(2n), commitment: h(3n), ciphertext: noteCt, asOf: "5", relayFee: { commitment: h(4n), ct: noteCt } };
    expect(feeOutputOf(parseRelayRequest("release", { proof: "0x01", publicInputs: release }))[0]!.commitment).toBe(h(4n) as `0x${string}`);
    const spend = {
      root: h(1n), nullifiers: [h(2n), h(3n)], commitments: [h(4n), h(5n), h(6n)], ciphertexts: [noteCt, noteCt, noteCt], publicAsset: `0x${"00".repeat(20)}`, withdrawAmount: "0",
      withdrawRecipient: `0x${"00".repeat(20)}`, relayer: `0x${"00".repeat(20)}`, relayerFee: "0",
    };
    expect(feeOutputOf(parseRelayRequest("spend", { proof: "0x01", publicInputs: spend }))[0]!.commitment).toBe(h(6n) as `0x${string}`);
    const lpSet = { root: h(1n), nullifier: h(2n), nextCommitment: h(3n), ct: Array.from({ length: 4 }, () => Array.from({ length: 12 }, () => h(1n))), asOf: "1", mode: "0" };
    expect(feeOutputOf(parseRelayRequest("setLiquidityRequest", { proof: "0x01", publicInputs: lpSet }))).toEqual([]);
    expect(feeOutputOf(parseRelayRequest("requestExit", { proof: "0x01", publicInputs: { root: h(1n), nullifier: h(2n) } }))).toEqual([]);
  });
});

describe("service token transport (re-audit)", () => {
  test("the maker's token goes only over https or loopback", () => {
    for (const url of ["https://api.rooq.trade", "http://127.0.0.1:8711", "http://127.9.0.1:8711", "http://localhost:8711", "http://[::1]:8711"]) expect(serviceTokenTransportAllowed(url)).toBe(true);
    for (const url of ["http://172.18.0.1:8711", "http://relayer.internal:8711", "http://127.0.0.1.example.com", "ws://127.0.0.1:8711"]) expect(serviceTokenTransportAllowed(url)).toBe(false);
  });
});
