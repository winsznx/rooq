import { ServiceError } from "./errors";

/** `details.scope` of a 429 from a keyed service's per-pool budget (see quoteRoute). */
export const QUOTE_POOL_BUDGET_SCOPE = "pool";

export type QuoteFetch = (url: string, init: RequestInit) => Promise<Response>;

const QUOTE_TIMEOUT_MS = 3_000;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : null;
  } catch {
    return null;
  }
}

/** A pool's sampling budget is spent: asking another service would only widen that budget, so the answer stands. */
function poolBudgetSpent(text: string): boolean {
  const details = parseObject(text)?.details;
  return typeof details === "object" && details !== null && "scope" in details && details.scope === QUOTE_POOL_BUDGET_SCOPE;
}

/**
 * Asks each keyed service in turn (coordinator, then the risk workers, REC-06), naming the caller in X-Forwarded-For so
 * each service limits per client rather than per read API. A 5xx, a timeout or a per-client 429 moves on to the next
 * service. An answer from a fallback service is still an indicative quote and says it came from one.
 */
export async function forwardQuote(urls: readonly string[], body: string, client: string | undefined, fetcher: QuoteFetch = fetch): Promise<Response> {
  let limited: string | null = null;
  for (const [i, base] of urls.entries()) {
    const res = await fetcher(`${base}/v1/spot/quote`, {
      method: "POST", headers: { "content-type": "application/json", ...(client ? { "x-forwarded-for": client } : {}) }, body, signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    }).catch(() => null);
    if (!res || res.status >= 500) continue;
    const text = await res.text();
    if (res.status === 429 && !poolBudgetSpent(text)) {
      limited = text;
      continue;
    }
    const quote = i > 0 && res.status === 200 ? parseObject(text) : null;
    return new Response(quote ? JSON.stringify({ ...quote, fallback: true }) : text, { status: res.status, headers: HEADERS });
  }
  if (limited !== null) return new Response(limited, { status: 429, headers: HEADERS });
  throw new ServiceError(503, "QUOTE_UNAVAILABLE", "No pricing service can answer right now.", true);
}
