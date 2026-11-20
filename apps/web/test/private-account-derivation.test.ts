import { privateKeyToAccount } from "viem/accounts";
import { serializeCompactSignature, signatureToCompactSignature, parseSignature, serializeSignature, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { accountMessage } from "../lib/private/account";
import { normalizedSignature, seedFromSignature } from "../lib/private/backup";
import { rememberedNames } from "../lib/private/vault";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const signer = privateKeyToAccount(KEY);

async function signed(): Promise<Hex> {
  return signer.signMessage({ message: accountMessage(signer.address, 2) });
}

describe("account derivation v2 (audit findings 26, 27)", () => {
  it("binds the message to the Rooq origin with fixed fields", () => {
    // #given the v2 message for one wallet
    const message = accountMessage(signer.address, 2);
    // #then it is a SIWE message for rooq.trade that never depends on the clock or the page
    expect(message.startsWith("rooq.trade wants you to sign in with your Ethereum account:")).toBe(true);
    expect(message).toContain(`\n${signer.address}\n`);
    expect(message).toContain("URI: https://rooq.trade");
    expect(message).toContain("Nonce: rooqprivateaccountv2");
    expect(message).toContain("Issued At: 2026-11-17T00:00:00.000Z");
    expect(accountMessage(signer.address.toLowerCase() as Hex, 2)).toBe(message);
  });

  it("gives one account whether the wallet returns v as 27/28, 0/1 or the compact form", async () => {
    // #given one signature in the three encodings wallets return
    const sig = await signed();
    const parsed = parseSignature(sig);
    const zeroOne = serializeSignature({ r: parsed.r, s: parsed.s, yParity: parsed.yParity });
    const v27 = serializeSignature({ r: parsed.r, s: parsed.s, v: BigInt(27 + (parsed.yParity ?? 0)) });
    const compact = serializeCompactSignature(signatureToCompactSignature(parsed));
    // #then every encoding derives the same seed
    const seed = seedFromSignature(sig, 2);
    expect(seedFromSignature(zeroOne, 2)).toBe(seed);
    expect(seedFromSignature(v27, 2)).toBe(seed);
    expect(seedFromSignature(compact, 2)).toBe(seed);
  });

  it("folds a high-s signature onto its low-s twin", async () => {
    // #given the malleable twin of a signature (s -> n - s, parity flipped)
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const parsed = parseSignature(await signed());
    const high = serializeSignature({ r: parsed.r, s: `0x${(N - BigInt(parsed.s)).toString(16).padStart(64, "0")}`, yParity: (parsed.yParity ?? 0) ^ 1 });
    // #then both normalize to the same bytes
    expect(normalizedSignature(high)).toEqual(normalizedSignature(serializeSignature(parsed)));
  });

  it("keeps version 1 exactly as before, so current accounts don't move", async () => {
    // #given a raw v1 signature
    const sig = await signer.signMessage({ message: accountMessage(signer.address, 1) });
    // #then v1 still hashes the raw bytes and differs from v2
    expect(accountMessage(signer.address, 1).startsWith("Rooq private account\n")).toBe(true);
    expect(seedFromSignature(sig, 1)).not.toBe(seedFromSignature(sig, 2));
  });

  it("refuses a long smart-wallet signature rather than truncating it into a seed", () => {
    const long = `0x${"ab".repeat(65)}${"00".repeat(100)}` as Hex;
    expect(() => seedFromSignature(long, 2)).toThrow();
  });
});

describe("forgetting a remembered wallet (re-audit)", () => {
  it("names the v1 and v2 remembered seeds and both device keys", () => {
    const address = "0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266";
    const lower = address.toLowerCase();
    expect(rememberedNames(address).sort()).toEqual([`device-key:${lower}`, `device-key:v2:${lower}`, `remember:${lower}`, `remember:v2:${lower}`]);
  });
});
