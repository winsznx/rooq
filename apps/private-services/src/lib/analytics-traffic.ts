import { isAllowedRoute, PV_SITES, type DeviceClass, type PageviewBeacon, type PvSite } from "@rooq/private-sdk/admin";
import { badRequest } from "./errors";

/** A sendBeacon body is a few dozen bytes; anything near this is not a beacon. */
export const BEACON_MAX_BYTES = 2_048;
export const BEACON_PER_MINUTE = 60;

const DEVICES: readonly DeviceClass[] = ["mobile", "tablet", "desktop"];
const BEACON_FIELDS: ReadonlySet<string> = new Set(["site", "route", "ref", "device", "first"]);
const HOST = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

const isSite = (v: unknown): v is PvSite => typeof v === "string" && (PV_SITES as readonly string[]).includes(v);
const isDevice = (v: unknown): v is DeviceClass => typeof v === "string" && (DEVICES as readonly string[]).includes(v);

/**
 * Accepts only the five beacon fields with their exact shapes. The route must already be a known pattern, so a raw path,
 * an account id or a query string is refused here as well as never sent by the beacon.
 */
export function parseBeacon(body: Record<string, unknown>): PageviewBeacon {
  for (const key of Object.keys(body)) if (!BEACON_FIELDS.has(key)) throw badRequest(`Unknown beacon field ${key}.`);
  const { site, route, ref, device, first } = body;
  if (!isSite(site)) throw badRequest(`site must be one of ${PV_SITES.join(", ")}.`);
  if (typeof route !== "string" || !isAllowedRoute(site, route)) throw badRequest("route is not a known route pattern.");
  if (ref !== null && (typeof ref !== "string" || !HOST.test(ref))) throw badRequest("ref must be a host name or null.");
  if (!isDevice(device)) throw badRequest(`device must be one of ${DEVICES.join(", ")}.`);
  if (first !== null && typeof first !== "boolean") throw badRequest("first must be true, false or null.");
  return { site, route, ref: ref === null ? null : ref.replace(/^www\./, ""), device, first };
}

/** Origins allowed to read the beacon response: the configured app origins plus the web and docs sites. */
export function beaconOrigins(allowed: readonly string[], extra: readonly string[]): ReadonlySet<string> {
  return new Set([...allowed, ...extra].map((o) => o.trim().replace(/\/+$/, "")).filter((o) => o !== ""));
}

export function beaconCors(origin: string | null, origins: ReadonlySet<string>): Record<string, string> {
  if (!origin || !origins.has(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600", vary: "origin" };
}
