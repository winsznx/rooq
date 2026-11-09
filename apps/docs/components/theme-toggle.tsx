"use client";

import { useSyncExternalStore } from "react";
import styles from "./docs.module.css";

type Theme = "light" | "dark";

const KEY = "rooq-docs-theme";
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    /* Blocked storage only costs persistence: the theme still applies for this page view. */
  }
  listeners.forEach((listener) => listener());
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  return (
    <div aria-label="Theme" className={styles.segmented} role="group">
      {(["light", "dark"] as const).map((option) => (
        <button aria-pressed={theme === option} key={option} onClick={() => setTheme(option)} type="button">
          {option === "light" ? "Light" : "Dark"}
        </button>
      ))}
    </div>
  );
}
