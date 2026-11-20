import type { ReactNode } from "react";
import styles from "@/app/admin/admin.module.css";

export function AdminPageHead({ title, meta, lede }: { title: string; meta?: ReactNode; lede?: ReactNode }): React.JSX.Element {
  return (
    <header className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
      <div className={styles.head}>
        <h1 className={styles.title}>{title}</h1>
        {meta ? <div className={styles.meta}>{meta}</div> : null}
      </div>
      {lede ? <p className={styles.lede}>{lede}</p> : null}
    </header>
  );
}
