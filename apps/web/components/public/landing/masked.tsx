"use client";

import { Eye } from "../../icons";
import styles from "./landing.module.css";

const DOTS = "••••••";

/** The eye control used everywhere on the landing: it shows or hides the figures it sits beside. */
export function EyeToggle({ hidden, onToggle, label }: { hidden: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className={styles.eye} aria-pressed={hidden} aria-label={`${hidden ? "Show" : "Hide"} ${label}`} onClick={onToggle}>
      <Eye size={16} off={hidden} />
    </button>
  );
}

/** A figure that is either its value or a row of dots. */
export function Masked({ hidden, children }: { hidden: boolean; children: string }) {
  return hidden ? (
    <span className={styles.dots} aria-label="Hidden">
      {DOTS}
    </span>
  ) : (
    <>{children}</>
  );
}
