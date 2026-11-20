import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { adminSiweMessage, checkAdminSiwe } from "../lib/admin/siwe";
import { importSigningKey, issueNonce, issueSession, NONCE_TTL_S, readNonce, readSession, SESSION_TTL_S } from "../lib/admin/token";

const SECRET = "x".repeat(32);
const OTHER = "y".repeat(32);
const ADMIN = "0x364d832497792553BEE55c531344510B8Ca52657" as const;
const NOW = 1_800_000_000;
const ORIGIN = "https://rooq.trade";
const NONCE = "abcDEF1234567890";

describe("session tokens", () => {
  it("round-trips and lowercases the address", async () => {
    const key = await importSigningKey(SECRET);
    const { token, session } = await issueSession(key, ADMIN, NOW);
    expect(session).toEqual({ address: ADMIN.toLowerCase() as `0x${string}`, exp: NOW + SESSION_TTL_S });
    expect(await readSession(key, token, NOW + 10)).toEqual(session);
  });
  it("expires at exp", async () => {
    const key = await importSigningKey(SECRET);
    const { token } = await issueSession(key, ADMIN, NOW);
    expect(await readSession(key, token, NOW + SESSION_TTL_S)).toBeNull();
  });
  it("rejects another secret, tampering and a nonce token", async () => {
    const key = await importSigningKey(SECRET);
    const { token } = await issueSession(key, ADMIN, NOW);
    expect(await readSession(await importSigningKey(OTHER), token, NOW)).toBeNull();
    const [addr, iat, exp, mac] = token.split(".");
    expect(await readSession(key, `${addr}.${iat}.${Number(exp) + 1}.${mac}`, NOW)).toBeNull();
    expect(await readSession(key, `0x${"1".repeat(40)}.${iat}.${exp}.${mac}`, NOW)).toBeNull();
    expect(await readSession(key, `${token}A`, NOW)).toBeNull();
    expect(await readSession(key, "", NOW)).toBeNull();
    expect(await readSession(key, "a.b.c.d.e", NOW)).toBeNull();
    const nonce = await issueNonce(key, NONCE, NOW);
    expect(await readSession(key, `${nonce.split(".")[0]}.${NOW}.${nonce.split(".").slice(1).join(".")}`, NOW)).toBeNull();
  });
  it("rejects a session issued in the future", async () => {
    const key = await importSigningKey(SECRET);
    const { token } = await issueSession(key, ADMIN, NOW + 3600);
    expect(await readSession(key, token, NOW)).toBeNull();
  });
  it("refuses a session issued before the epoch, so raising ADMIN_SESSION_EPOCH revokes it", async () => {
    const key = await importSigningKey(SECRET);
    const { token, session } = await issueSession(key, ADMIN, NOW);
    expect(await readSession(key, token, NOW + 10, NOW)).toEqual(session);
    expect(await readSession(key, token, NOW + 10, NOW + 1)).toBeNull();
  });
});

describe("nonce tokens", () => {
  it("round-trips until the nonce lifetime ends", async () => {
    const key = await importSigningKey(SECRET);
    const token = await issueNonce(key, NONCE, NOW);
    expect(await readNonce(key, token, NOW + NONCE_TTL_S - 1)).toBe(NONCE);
    expect(await readNonce(key, token, NOW + NONCE_TTL_S)).toBeNull();
  });
  it("never accepts a session token", async () => {
    const key = await importSigningKey(SECRET);
    const { token } = await issueSession(key, ADMIN, NOW);
    const [addr, , exp, mac] = token.split(".");
    expect(await readNonce(key, `${addr}.${exp}.${mac}`, NOW)).toBeNull();
  });
  it("refuses a malformed nonce at issue time", async () => {
    const key = await importSigningKey(SECRET);
    expect(() => issueNonce(key, "a.b", NOW)).toThrow();
  });
});

describe("SIWE checks", () => {
  const now = new Date(NOW * 1000);
  const expected = { origin: ORIGIN, chainId: 46630, nonce: NONCE, now };
  const message = adminSiweMessage({ address: ADMIN, origin: ORIGIN, chainId: 46630, nonce: NONCE, now });

  it("accepts the message the browser builds", () => {
    expect(checkAdminSiwe(message, expected)).toEqual({ ok: true, address: ADMIN });
  });
  it("rejects another site, chain or nonce", () => {
    expect(checkAdminSiwe(message, { ...expected, origin: "https://evil.example" })).toEqual({ ok: false, reason: "wrong_site" });
    expect(checkAdminSiwe(message, { ...expected, chainId: 1 })).toEqual({ ok: false, reason: "wrong_chain" });
    expect(checkAdminSiwe(message, { ...expected, nonce: "zzzzzzzzzzzz" })).toEqual({ ok: false, reason: "wrong_nonce" });
  });
  it("expires with the nonce and refuses future-dated messages", () => {
    expect(checkAdminSiwe(message, { ...expected, now: new Date(now.getTime() + NONCE_TTL_S * 1000) })).toEqual({ ok: false, reason: "expired" });
    expect(checkAdminSiwe(message, { ...expected, now: new Date(now.getTime() - 120_000) })).toEqual({ ok: false, reason: "expired" });
  });
  it("rejects non-canonical text around a valid message", () => {
    expect(checkAdminSiwe(`junk\n${message}`, expected)).toEqual({ ok: false, reason: "malformed" });
    expect(checkAdminSiwe(`${message}\nextra`, expected)).toEqual({ ok: false, reason: "malformed" });
    expect(checkAdminSiwe(message.replace("Sign in to Rooq admin", "Open my account"), expected)).toEqual({ ok: false, reason: "malformed" });
  });
  it("signs and verifies with an EOA", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const own = adminSiweMessage({ address: account.address, origin: ORIGIN, chainId: 46630, nonce: NONCE, now });
    const signature = await account.signMessage({ message: own });
    expect(checkAdminSiwe(own, expected)).toEqual({ ok: true, address: account.address });
    expect(await verifyMessage({ address: account.address, message: own, signature })).toBe(true);
  });
});
