import "server-only";
import { isAddress } from "viem";

/**
 * Server-only admin configuration. Every reader fails closed: a missing or malformed value returns null and the
 * caller treats the admin area as unavailable, never as open. Values are never logged, only which one is wrong.
 */

const MIN_SECRET_BYTES = 32;
const DEV_SITE_URL = "http://localhost:3200";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface AdminAuthEnv {
  /** The site origin sign-in requests must come from, e.g. "https://rooq.trade". */
  origin: string;
  /** False only for `next dev` on a loopback origin, where cookies cannot carry Secure or the __Host- prefix. */
  secure: boolean;
  secret: string;
  /** Lowercased owner wallets. */
  addresses: ReadonlySet<string>;
  /**
   * Unix seconds from ADMIN_SESSION_EPOCH; sessions issued before it are refused. Sign-out only drops the browser's
   * cookie, so raising this is how a copied session is revoked without rotating ADMIN_SESSION_SECRET. 0 when unset.
   */
  sessionEpoch: number;
}

export interface AnalyticsEnv {
  /** Analytics service base URL without a trailing slash. */
  url: string;
  token: string;
}

export function adminAuthEnv(): AdminAuthEnv | null {
  const isDev = process.env.NODE_ENV === "development";
  const origin = parseUrl(process.env.NEXT_PUBLIC_SITE_URL ?? (isDev ? DEV_SITE_URL : undefined));
  if (!origin) return misconfigured("NEXT_PUBLIC_SITE_URL is missing or not a URL");
  const loopbackDev = isDev && origin.protocol === "http:" && LOOPBACK_HOSTS.has(origin.hostname);
  if (origin.protocol !== "https:" && !loopbackDev) return misconfigured("NEXT_PUBLIC_SITE_URL must be https outside local development");

  const secret = process.env.ADMIN_SESSION_SECRET ?? "";
  if (new TextEncoder().encode(secret).length < MIN_SECRET_BYTES) return misconfigured(`ADMIN_SESSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);

  const addresses = parseAddresses(process.env.ADMIN_ADDRESSES ?? "");
  if (!addresses) return misconfigured("ADMIN_ADDRESSES must be a comma separated list of one or more addresses");

  const epoch = process.env.ADMIN_SESSION_EPOCH?.trim() || "0";
  if (!/^\d{1,12}$/.test(epoch)) return misconfigured("ADMIN_SESSION_EPOCH must be unix seconds");

  return { origin: origin.origin, secure: !loopbackDev, secret, addresses, sessionEpoch: Number(epoch) };
}

export function analyticsEnv(): AnalyticsEnv | null {
  const url = parseUrl(process.env.ANALYTICS_API_URL);
  if (!url || (url.protocol !== "https:" && !(process.env.NODE_ENV === "development" && LOOPBACK_HOSTS.has(url.hostname)))) {
    return misconfigured("ANALYTICS_API_URL must be an https URL");
  }
  const token = process.env.ADMIN_API_TOKEN ?? "";
  if (new TextEncoder().encode(token).length < MIN_SECRET_BYTES) return misconfigured(`ADMIN_API_TOKEN must be at least ${MIN_SECRET_BYTES} bytes`);
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, token };
}

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseAddresses(value: string): ReadonlySet<string> | null {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || !entries.every((entry) => isAddress(entry, { strict: false }))) return null;
  return new Set(entries.map((entry) => entry.toLowerCase()));
}

const reported = new Set<string>();

function misconfigured(reason: string): null {
  if (!reported.has(reason)) {
    reported.add(reason);
    console.error(`rooq admin disabled: ${reason}`);
  }
  return null;
}
