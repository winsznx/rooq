import { describe, expect, test } from "bun:test";
import { ApiError, DeadlineError, badRequest, errorBody, indexerUnavailable, toApiError } from "../src/errors";
import { corsHeaders, parseAddress, parseBytes32, parseUint, stringify, RateLimiter } from "../src/http";
import { decodeCursor, encodeCursor } from "../src/cursor";

describe("error envelope", () => {
  test("carries the stable fields and a fresh request id per call", () => {
    // #given one error rendered twice
    const error = badRequest("wallet must be a 20-byte hex address.");
    // #when
    const a = errorBody(error);
    const b = errorBody(error);
    // #then
    expect([a.statusCode, a.reasonCode, a.canRetry, a.message, a.requestId !== b.requestId, "details" in a]).toEqual([
      400,
      "INVALID_REQUEST",
      false,
      "wallet must be a 20-byte hex address.",
      true,
      false,
    ]);
  });

  test("never exposes the message or stack of an unexpected error", () => {
    // #given an internal failure with a sensitive message
    const leaked = new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    // #when
    const body = errorBody(toApiError(leaked));
    // #then
    expect([body.statusCode, body.reasonCode, body.message, JSON.stringify(body).includes("hunter2")]).toEqual([500, "INTERNAL", "Internal error.", false]);
  });

  test("maps a missed deadline to a retryable NETWORK_DELAYED 503", () => {
    const e = toApiError(new DeadlineError(5_000));
    expect([e.statusCode, e.reasonCode, e.canRetry]).toEqual([503, "NETWORK_DELAYED", true]);
  });

  test("passes API errors through unchanged", () => {
    const original = indexerUnavailable();
    expect(toApiError(original)).toBe(original);
  });

  test("keeps details when they are provided", () => {
    expect(errorBody(new ApiError(422, "MIN_OUTPUT", "x", true, { errorName: "InsufficientOutput" })).details).toEqual({ errorName: "InsufficientOutput" });
  });
});

describe("CORS", () => {
  const allowed = ["http://localhost:3200", "http://127.0.0.1:3200"];

  test("grants exactly the listed origin", () => {
    // #when / #then
    expect(corsHeaders("http://localhost:3200", allowed)["access-control-allow-origin"]).toBe("http://localhost:3200");
  });

  test("grants nothing to an unlisted or missing origin", () => {
    expect([corsHeaders("http://localhost:3000", allowed), corsHeaders(null, allowed)]).toEqual([{}, {}]);
  });
});

describe("request parsing", () => {
  test("checksums addresses and rejects malformed ones", () => {
    expect(parseAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "wallet")).toBe("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    expect(() => parseAddress("0x3c44", "wallet")).toThrow("wallet must be a 20-byte hex address.");
  });

  test("lowercases 32-byte ids and rejects short ones", () => {
    expect(parseBytes32(`0x${"AB".repeat(32)}`, "marketId")).toBe(`0x${"ab".repeat(32)}`);
    expect(() => parseBytes32("0x1234", "marketId")).toThrow("marketId must be a 32-byte hex string.");
  });

  test("accepts uint256 decimal strings only", () => {
    // #given the boundary values
    const max = (2n ** 256n - 1n).toString();
    // #then numbers, negatives, decimals and overflow are refused
    expect(parseUint(max, "amountIn")).toBe(2n ** 256n - 1n);
    for (const bad of [1000, "-1", "1.5", (2n ** 256n).toString(), "1e18"]) expect(() => parseUint(bad, "amountIn")).toThrow();
  });

  test("serialises bigints as decimal strings", () => {
    expect(stringify({ a: 2n ** 70n, b: [1n] })).toBe(`{"a":"${(2n ** 70n).toString()}","b":["1"]}`);
  });
});

describe("pagination cursors", () => {
  test("round-trip the keyset parts", () => {
    // #given an activity position
    const raw = encodeCursor("activity", [140n, 3n, 9001n]);
    // #then it decodes to the same parts
    expect(decodeCursor("activity", raw)).toEqual([140n, 3n, 9001n]);
  });

  test("reject a cursor minted for another listing", () => {
    expect(decodeCursor("activity", encodeCursor("trades", [1n, 2n]))).toBeNull();
  });

  test("reject tampered, non-numeric and non-base64url input", () => {
    const sqlish = Buffer.from("v1:trades:1:2;drop", "utf8").toString("base64url");
    expect([decodeCursor("trades", sqlish), decodeCursor("trades", "%%%"), decodeCursor("trades", ""), decodeCursor("trades", "Zm9v")]).toEqual([null, null, null, null]);
  });

  test("cannot encode negative parts", () => {
    expect(() => encodeCursor("markets", [-1n])).toThrow();
  });
});

describe("rate limiter", () => {
  test("allows the limit within a window and recovers after it", () => {
    // #given 2 requests per second
    const limiter = new RateLimiter(2, 1_000);
    // #when three arrive at once and one after the window
    const results = [limiter.allow("ip", 0), limiter.allow("ip", 10), limiter.allow("ip", 20), limiter.allow("ip", 1_500)];
    // #then
    expect(results).toEqual([true, true, false, true]);
  });
});
