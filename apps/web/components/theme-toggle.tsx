"use client";

import { useSyncExternalStore } from "react";
import { applyTheme, readThemePreference, type ThemePreference } from "@/lib/theme";
import { Monitor, Moon, Sun } from "./icons";

const ORDER: readonly ThemePreference[] = ["light", "dark", "system"];
const LABEL: Record<ThemePreference, string> = { light: "Light theme", dark: "Dark theme", system: "Match system theme" };

function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-pref"] });
  return () => observer.disconnect();
}

/** Theme switches instantly with no crossfade (MOTION_AND_SCROLL.md). */
export function ThemeToggle() {
  const pref = useSyncExternalStore(subscribe, readThemePreference, () => "system" as ThemePreference);
  const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length] ?? "light";
  const Icon = pref === "dark" ? Moon : pref === "light" ? Sun : Monitor;
  return (
    <button type="button" className="btn btn-ghost btn-icon" onClick={() => applyTheme(next)} aria-label={`${LABEL[pref]}. Switch to ${LABEL[next].toLowerCase()}`} title={LABEL[pref]}>
      <Icon />
    </button>
  );
}
