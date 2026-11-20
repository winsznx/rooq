import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../../src/lib/http";

describe("rate limiter (audit #15)", () => {
  test("refused requests are not recorded, so a key never holds more than its limit", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 10_000; i++) limiter.allow("k", 30, 1_000 + i);
    expect(limiter.size("k", 20_000)).toBe(30);
  });

  test("a client that keeps flooding gets through once its accepted hits age out", () => {
    const limiter = new RateLimiter();
    for (let t = 0; t < 3; t++) expect(limiter.allow("k", 3, t)).toBe(true);
    for (let t = 1_000; t < 59_000; t += 10) expect(limiter.allow("k", 3, t)).toBe(false);
    expect(limiter.allow("k", 3, 60_001)).toBe(true);
  });

  test("allows exactly the limit per window", () => {
    const limiter = new RateLimiter();
    const allowed = Array.from({ length: 5 }, (_, i) => limiter.allow("k", 3, i)).filter(Boolean).length;
    expect(allowed).toBe(3);
  });

  test("allowAll charges every key or none", () => {
    const limiter = new RateLimiter();
    expect(limiter.allow("a", 1, 0)).toBe(true);
    expect(limiter.allowAll(["a", "b"], 1, 1)).toBe(false);
    expect(limiter.size("b", 1)).toBe(0);
    expect(limiter.allowAll(["b", "b"], 1, 2)).toBe(true);
    expect(limiter.size("b", 2)).toBe(1);
  });

  test("allowEach reports the key at its limit", () => {
    const limiter = new RateLimiter(3_600_000);
    expect(limiter.allowEach([{ key: "x", limit: 1 }, { key: "y", limit: 5 }], 0)).toBeNull();
    expect(limiter.allowEach([{ key: "y", limit: 5 }, { key: "x", limit: 1 }], 1_000_000)).toBe("x");
    expect(limiter.size("y", 1_000_000)).toBe(1);
  });

  test("prune drops keys whose hits have all expired", () => {
    const limiter = new RateLimiter();
    limiter.allow("k", 3, 0);
    limiter.prune(60_000);
    expect(limiter.size("k", 60_000)).toBe(0);
  });
});
