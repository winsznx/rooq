import { describe, expect, test } from "bun:test";
import { bearerMatches, MIN_ADMIN_TOKEN_LENGTH, requireBearer, takeAdminToken } from "../../src/lib/analytics-auth";
import { ServiceError } from "../../src/lib/errors";

const TOKEN = "t".repeat(MIN_ADMIN_TOKEN_LENGTH) + "-admin";

describe("admin token from the environment", () => {
  test("is removed from the environment once read", () => {
    const env: Record<string, string | undefined> = { ADMIN_API_TOKEN: TOKEN };
    expect(takeAdminToken(env)).toEqual({ ok: true, token: TOKEN });
    expect("ADMIN_API_TOKEN" in env).toBe(false);
  });

  test("fails closed when missing or blank", () => {
    expect(takeAdminToken({})).toEqual({ ok: false, reason: "ADMIN_TOKEN_MISSING" });
    expect(takeAdminToken({ ADMIN_API_TOKEN: "   " })).toEqual({ ok: false, reason: "ADMIN_TOKEN_MISSING" });
  });

  test("fails closed when too short to resist guessing", () => {
    const env: Record<string, string | undefined> = { ADMIN_API_TOKEN: "short" };
    expect(takeAdminToken(env)).toEqual({ ok: false, reason: "ADMIN_TOKEN_TOO_SHORT" });
    expect("ADMIN_API_TOKEN" in env).toBe(false);
  });
});

describe("bearer check", () => {
  test("accepts the exact token with any case of the scheme", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test("rejects a missing header, another scheme, a wrong or padded token", () => {
    expect(bearerMatches(null, TOKEN)).toBe(false);
    expect(bearerMatches("", TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
  });

  test("compares digests, so tokens of any length are checked without throwing", () => {
    expect(() => bearerMatches("Bearer x", TOKEN)).not.toThrow();
    expect(() => bearerMatches(`Bearer ${"y".repeat(4_096)}`, TOKEN)).not.toThrow();
  });

  test("never matches when the expected token is empty or short, even against itself", () => {
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches("Bearer short", "short")).toBe(false);
  });

  test("an unauthenticated request is a 401 UNAUTHORIZED", () => {
    let thrown: unknown = null;
    try {
      requireBearer(new Request("http://x/v1/admin/overview"), TOKEN);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ServiceError);
    expect(thrown).toMatchObject({ statusCode: 401, reasonCode: "UNAUTHORIZED" });
  });
});
