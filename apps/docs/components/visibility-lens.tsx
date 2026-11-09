"use client";

import { useState } from "react";
import { OBSERVERS, VISIBILITY_ROWS, reachLabel } from "@/lib/visibility";
import styles from "./docs.module.css";

/** Pick an observer and read the whole system from where they stand. */
export function VisibilityLens() {
  const [observer, setObserver] = useState(OBSERVERS[0]?.id ?? "public");
  const selected = OBSERVERS.find((o) => o.id === observer);

  return (
    <section aria-label="See Rooq as each observer" className={styles.lens}>
      <p className={styles.lensLabel}>See Rooq as</p>
      <div className={styles.lensPills} role="group" aria-label="Observer">
        {OBSERVERS.map((o) => (
          <button aria-pressed={o.id === observer} key={o.id} onClick={() => setObserver(o.id)} type="button">
            {o.label}
          </button>
        ))}
      </div>
      <p aria-live="polite" className={styles.lensIntro}>
        {selected?.intro}
      </p>
      <ul className={styles.lensRows}>
        {VISIBILITY_ROWS.map((row) => {
          const cell = row.cells[observer];
          if (!cell) return null;
          const [reach, detail] = cell;
          return (
            <li key={row.item}>
              <span className={styles.lensItem}>{row.item}</span>
              <span className={styles.lensReach} data-reach={reach}>
                {reachLabel(reach)}
              </span>
              <span className={styles.lensDetail}>{detail}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
