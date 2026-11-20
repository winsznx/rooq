"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { referrerHost, routePattern, type DeviceClass, type PageviewBeacon } from "@rooq/private-sdk/admin";
import { PV_URL } from "@/lib/pv-url";

const OWN_HOSTS = ["rooq.trade", "docs.rooq.trade", "localhost", "127.0.0.1"] as const;
const DAY_KEY = "rooq-pv-day";

function optedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || nav.webdriver;
}

function device(): DeviceClass {
  const width = window.innerWidth;
  return width < 640 ? "mobile" : width < 1024 ? "tablet" : "desktop";
}

/** A date, never an id: it only says whether this browser already counted a visit today. Null when storage is blocked. */
function firstToday(): boolean | null {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem(DAY_KEY) === today) return false;
    localStorage.setItem(DAY_KEY, today);
    return true;
  } catch {
    return null;
  }
}

function send(url: string, beacon: PageviewBeacon): void {
  const body = JSON.stringify(beacon);
  if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, body)) return;
  fetch(url, { method: "POST", body, keepalive: true, mode: "no-cors", credentials: "omit" }).catch(() => {
    /* A lost pageview isn't worth surfacing to the visitor. */
  });
}

/** Counts a pageview per route pattern with no cookie and no identifier. Operator pages under /admin aren't counted. */
export function AnalyticsBeacon(): null {
  const pathname = usePathname();
  const lastSent = useRef<string | null>(null);
  const landed = useRef(false);

  useEffect(() => {
    if (pathname === lastSent.current) return;
    lastSent.current = pathname;
    if (!PV_URL || pathname === "/admin" || pathname.startsWith("/admin/") || optedOut()) return;
    const ref = landed.current ? null : referrerHost(document.referrer, OWN_HOSTS);
    landed.current = true;
    send(PV_URL, { site: "web", route: routePattern("web", pathname), ref, device: device(), first: firstToday() });
  }, [pathname]);

  return null;
}
