import { describe, expect, test } from "bun:test";
import { applyMultiplier, ReferencePriceSource, toFeedUnits, type ReferenceQuote } from "@rooq/config";
import { clientKey } from "../../src/lib/http";

const NOW = Date.parse("2026-11-09T12:00:00Z");

function sourceFor(quote: Record<string, unknown>, multiplier = "1.000000000000000000"): ReferencePriceSource {
  const fetcher = <T>(url: string): Promise<T> =>
    Promise.resolve((url.endsWith("/assets") ? { assets: [{ tokenSymbol: "TSLA", currentMultiplier: multiplier, status: "ASSET_STATUS_ACTIVE" }] } : { quotes: [{ bid: "358.9", ask: "360", isTradingHalt: false, generatedAt: "2026-11-09T11:59:30Z", ...quote }] }) as T);
  return new ReferencePriceSource(120, 300_000, fetcher, () => NOW);
}

async function quote(q: Record<string, unknown>, multiplier?: string): Promise<ReferenceQuote> {
  const source = sourceFor(q, multiplier);
  await source.refreshMultipliers();
  return source.quote("TSLA");
}

describe("reference price", () => {
  test("mid price in 8 decimals with no floating point", () => {
    expect(toFeedUnits("358.9")).toBe(35_890_000_000n);
    expect(applyMultiplier(35_945_000_000n, "1.500000000000000000")).toBe(53_917_500_000n);
  });

  test("a live quote gives the mid, multiplier applied", async () => {
    const q = await quote({}, "1.100000000000000000");
    expect(q).toMatchObject({ status: "ok", answer8: (35_945_000_000n * 11n) / 10n });
  });

  test("fails closed on halt, old, inverted and zero quotes", async () => {
    expect((await quote({ isTradingHalt: true })).status).toBe("halted");
    expect((await quote({ generatedAt: "2026-11-09T11:50:00Z" })).status).toBe("stale");
    expect((await quote({ generatedAt: "not a date" })).status).toBe("stale");
    expect((await quote({ bid: "361" })).status).toBe("invalid");
    expect((await quote({ bid: "0" })).status).toBe("invalid");
  });

  test("an asset with no active multiplier gives no price", async () => {
    const source = sourceFor({});
    expect((await source.quote("TSLA")).status).toBe("no_multiplier");
  });
});

describe("rate limit client key", () => {
  const req = (xff?: string): Request => new Request("http://x/", { headers: xff ? { "x-forwarded-for": xff } : {} });

  test("ignores X-Forwarded-For unless a proxy is trusted", () => {
    expect(clientKey(req("9.9.9.9"), "127.0.0.1", false)).toBe("127.0.0.1");
  });

  test("uses the entry the trusted proxy appended, not what the client sent", () => {
    expect(clientKey(req("6.6.6.6, 9.9.9.9"), "127.0.0.1", true)).toBe("9.9.9.9");
  });

  test("falls back to the peer when no header is present", () => {
    expect(clientKey(req(), "127.0.0.1", true)).toBe("127.0.0.1");
  });
});
