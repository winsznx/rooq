/**
 * Readers for a service's own /health body, which the analytics service passes through untyped. Each reader
 * checks the shape it expects and returns null otherwise, so a service on an older build can't break the page.
 */

type Health = Record<string, unknown> | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bigints arrive as decimal strings from the services' JSON encoder. */
export function healthNumber(health: Health, key: string): number | null {
  const value = health?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

export function healthString(health: Health, key: string): string | null {
  const value = health?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `lastError.at` is an ISO timestamp. Returns unix seconds. */
export function healthError(health: Health): { message: string; at: number | null } | null {
  const value = health?.lastError;
  if (!isRecord(value) || typeof value.message !== "string") return null;
  const at = typeof value.at === "string" ? Date.parse(value.at) : Number.NaN;
  return { message: value.message, at: Number.isFinite(at) ? Math.floor(at / 1000) : null };
}

/** Flat numeric maps such as `counters` and `backlog`. Non-numeric entries are dropped. */
export function healthCounts(health: Health, key: string): [string, number][] {
  const value = health?.[key];
  if (!isRecord(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
}
