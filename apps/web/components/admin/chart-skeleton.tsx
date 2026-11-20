import styles from "@/app/admin/admin.module.css";

export function ChartSkeleton({ label = "Loading chart" }: { label?: string }): React.JSX.Element {
  return (
    <div className={styles.figure} aria-busy="true" aria-label={label}>
      <div className={styles.figHead}>
        <span className="skeleton" style={{ display: "inline-block", width: 120, height: 14 }} aria-hidden />
      </div>
      <div className={styles.canvas} />
    </div>
  );
}
