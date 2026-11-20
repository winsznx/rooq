const READ = process.env.NEXT_PUBLIC_PRIVATE_READ_URL ?? "http://127.0.0.1:8710";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** PORTS.analytics in apps/private-services/src/lib/config.ts. */
const LOCAL_PV_URL = "http://127.0.0.1:8718/v1/pv";

/**
 * Where the pageview beacon posts. In production the read API's host routes /v1/pv to the analytics service; a local
 * stack has no such proxy, so a loopback read URL means the analytics port directly. NEXT_PUBLIC_PV_URL overrides
 * both, the same variable the docs app reads. Null when the read URL is unusable.
 */
export const PV_URL: string | null = process.env.NEXT_PUBLIC_PV_URL ?? derivePvUrl(READ);

function derivePvUrl(readUrl: string): string | null {
  try {
    const url = new URL(readUrl);
    return LOOPBACK_HOSTS.has(url.hostname) ? LOCAL_PV_URL : `${url.origin}/v1/pv`;
  } catch {
    return null;
  }
}
