/**
 * Opaque pagination cursors. The wire form is base64url("v1:<kind>:<part>:<part>...") where every part
 * is a non-negative decimal integer, so a cursor can never smuggle SQL or arbitrary text.
 */
export type CursorKind = "trades" | "activity" | "markets";

const PARTS: Record<CursorKind, number> = { trades: 2, activity: 3, markets: 1 };

export function encodeCursor(kind: CursorKind, parts: readonly bigint[]): string {
  if (parts.length !== PARTS[kind] || parts.some((p) => p < 0n)) throw new RangeError(`bad ${kind} cursor parts`);
  return Buffer.from(`v1:${kind}:${parts.join(":")}`, "utf8").toString("base64url");
}

/** Returns the decoded parts, or null for anything malformed, of the wrong kind or out of range. */
export function decodeCursor(kind: CursorKind, raw: string): bigint[] | null {
  if (raw.length === 0 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [version, k, ...parts] = text.split(":");
  if (version !== "v1" || k !== kind || parts.length !== PARTS[kind]) return null;
  if (!parts.every((p) => /^\d{1,30}$/.test(p))) return null;
  return parts.map((p) => BigInt(p));
}
