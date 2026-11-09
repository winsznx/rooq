import Link from "next/link";
import type { Route } from "next";
import styles from "./create.module.css";

const STEPS: readonly { label: string; href: Route }[] = [
  { label: "Asset", href: "/app/create/asset" },
  { label: "Spot liquidity", href: "/app/create/liquidity" },
  { label: "Leverage", href: "/app/create/leverage" },
  { label: "Check requirements", href: "/app/create/preflight" },
  { label: "Review", href: "/app/create/review" },
];

/** The create flow is a real sequence, so numbered steps carry information here. Earlier steps stay reachable. */
export function CreateSteps({ current }: { current: number }) {
  return (
    <ol className={styles.steps} aria-label="Create market steps">
      {STEPS.map((s, i) => (
        <li key={s.label} data-state={i < current ? "done" : i === current ? "current" : "todo"} aria-current={i === current ? "step" : undefined}>
          <span className={styles.stepNum}>{i + 1}</span>
          {i < current ? <Link href={s.href}>{s.label}</Link> : s.label}
        </li>
      ))}
    </ol>
  );
}
