"use client";

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { StateBlock } from "@/components/primitives";
import type { AdminApiError } from "@/lib/admin/hooks";
import styles from "@/app/admin/admin.module.css";

/** A full page load, because the layout reads the session cookie on the server and must run again. */
function SignInAgain(): React.JSX.Element {
  return (
    <StateBlock
      kind="locked"
      title="Your admin session ended"
      body="Sessions last up to 12 hours. Sign in again with an owner wallet to keep reading."
      actions={
        <a className="btn btn-sm" href="/admin">
          Sign in again
        </a>
      }
    />
  );
}

export function QueryError({ error, onRetry }: { error: AdminApiError; onRetry: () => void }): React.JSX.Element {
  if (error.signedOut) return <SignInAgain />;
  if (error.notConfigured) return <StateBlock kind="empty" title="Not set up on this deployment" body={error.message} />;
  return (
    <StateBlock
      kind="unavailable"
      title="This data didn't load"
      body={error.message}
      actions={
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      }
    />
  );
}

/**
 * Renders `children` with the data once it's there. A failed refresh keeps showing the last data it had,
 * so a blip in the analytics service doesn't blank a page the operator is reading.
 */
export function Loaded<T>({ query, fallback, children }: { query: UseQueryResult<T, AdminApiError>; fallback: ReactNode; children: (data: T) => ReactNode }): React.JSX.Element {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <QueryError error={query.error} onRetry={() => void query.refetch()} />;
  return <>{fallback}</>;
}

/** Placeholder rows for a table that is still loading, sized like the real thing so nothing jumps. */
export function TableSkeleton({ rows = 4, label }: { rows?: number; label: string }): React.JSX.Element {
  return (
    <div className="panel" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row" style={{ height: 52, padding: "0 16px", borderBottom: i < rows - 1 ? "1px solid var(--rq-line)" : undefined }}>
          <span className="skeleton" style={{ display: "inline-block", width: `${30 + ((i * 17) % 40)}%`, height: 12 }} aria-hidden />
        </div>
      ))}
    </div>
  );
}

/** Placeholder lines for a panel body that is still loading. */
export function PanelSkeleton({ label, lines = 3 }: { label: string; lines?: number }): React.JSX.Element {
  return (
    <div className={styles.panelSkeleton} aria-busy="true" aria-label={label}>
      <span className="skeleton" style={{ display: "inline-block", width: "45%", height: 28 }} aria-hidden />
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ display: "inline-block", width: `${50 + ((i * 23) % 40)}%`, height: 12 }} aria-hidden />
      ))}
    </div>
  );
}
