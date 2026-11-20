import type { AdminService, AdminServices, ServiceState } from "@rooq/private-sdk/admin";
import { PORTS, type Env } from "./config";
import { errorMessage } from "./log";

/** The services whose /health the admin page shows, in port order. Analytics answers for itself. */
const SERVICE_PORTS: readonly (readonly [string, number])[] = [
  ["read-api", PORTS.readApi], ["relayer", PORTS.relayer], ["queue", PORTS.queue], ["coordinator", PORTS.coordinator],
  ["risk-a", PORTS.riskA], ["risk-b", PORTS.riskB], ["maker", PORTS.maker], ["price-relay", PORTS.priceRelay],
];

export interface HealthTarget {
  readonly name: string;
  readonly url: string;
}

/**
 * Loopback by default. `ANALYTICS_HEALTH_URLS="read-api=http://172.18.0.1:8710,…"` overrides a service that binds
 * elsewhere, as read-api and the relayer do on the VPS so the proxy can reach them.
 */
export function healthTargets(env: Env): HealthTarget[] {
  const overrides = new Map<string, string>();
  for (const entry of (env.ANALYTICS_HEALTH_URLS ?? "").split(",").map((e) => e.trim()).filter((e) => e !== "")) {
    const eq = entry.indexOf("=");
    const name = entry.slice(0, eq).trim();
    const base = entry.slice(eq + 1).trim().replace(/\/+$/, "");
    if (eq <= 0 || !SERVICE_PORTS.some(([n]) => n === name) || !/^https?:\/\/[^/]+$/.test(base)) throw new Error(`ANALYTICS_HEALTH_URLS entry "${entry}" must be <service>=<http origin>`);
    overrides.set(name, base);
  }
  return SERVICE_PORTS.map(([name, port]) => ({ name, url: `${overrides.get(name) ?? `http://127.0.0.1:${port}`}/health` }));
}

/** Ok only when the service answers 200 and says so itself; any other answer is degraded. No answer at all is down. */
export function classifyHealth(status: number, body: Record<string, unknown> | null): ServiceState {
  return status === 200 && body?.status === "ok" ? "ok" : "degraded";
}

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export async function probeService(target: HealthTarget, timeoutMs: number, fetcher: Fetcher = fetch): Promise<AdminService> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetcher(target.url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { name: target.name, state: "down", health: null, latencyMs: null, error: errorMessage(error) };
  }
  const latencyMs = Math.round(performance.now() - started);
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    return { name: target.name, state: "degraded", health: null, latencyMs, error: `HTTP ${res.status}, body is not JSON: ${errorMessage(error)}` };
  }
  const health = typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body } : null;
  const state = classifyHealth(res.status, health);
  return { name: target.name, state, health, latencyMs, error: state === "ok" ? null : `HTTP ${res.status}` };
}

/** Probes every service at most once per `ttlMs`; callers inside that window share one round of requests. */
export class ServiceProbe {
  private last: { at: number; result: AdminServices } | null = null;
  private inFlight: Promise<AdminServices> | null = null;

  constructor(
    private readonly targets: readonly HealthTarget[],
    private readonly timeoutMs: number,
    private readonly ttlMs: number,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  snapshot(now = Date.now()): Promise<AdminServices> {
    if (this.last && now - this.last.at < this.ttlMs) return Promise.resolve(this.last.result);
    this.inFlight ??= Promise.all(this.targets.map((t) => probeService(t, this.timeoutMs, this.fetcher)))
      .then((services) => {
        const result = { checkedAt: Math.floor(Date.now() / 1000), services };
        this.last = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
