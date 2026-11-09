"use client";

import { formatFixed } from "@rooq/sdk";
import type { AccountFigures } from "@/lib/account-view";
import { setHideValues, useHideValues } from "@/lib/preferences";
import { useNow } from "@/lib/use-now";
import { Hint, Sensitive, Skeleton, StateBlock } from "../primitives";
import { Eye } from "../icons";
import styles from "./account.module.css";

export function HideValuesToggle() {
  const hidden = useHideValues();
  return (
    <button type="button" className="hide-toggle" aria-pressed={hidden} onClick={() => setHideValues(!hidden)} title="Hides figures on this screen only. It doesn't change what is onchain.">
      <Eye size={16} off={hidden} />
      {hidden ? "Show values" : "Hide values"}
    </button>
  );
}

function amount(value: bigint | null, f: AccountFigures, opts: { sign?: "always" } = {}) {
  return value === null ? "Unavailable" : formatFixed(value, f.decimals, 2, opts);
}

/** One primary figure with a stated basis; everything else is subordinate and aligned in a single row. */
export function AccountSummary({ f, stale, lastReadAt, actions }: { f: AccountFigures; stale: boolean; lastReadAt: number; actions?: React.ReactNode }) {
  const now = useNow();
  const staleFor = stale ? Math.max(0, now - Math.floor(lastReadAt / 1000)) : 0;
  const pnlTone = f.unrealizedPnl === null || f.unrealizedPnl === 0n ? undefined : f.unrealizedPnl > 0n ? "pos" : "neg";
  return (
    <section className={styles.summary} aria-label="Account summary">
      <div className={styles.primary}>
        <div className={styles.primaryText}>
          <h2 className={styles.primaryLabel}>
            Available capital
            <Hint label="How this is calculated">Your wallet {f.symbol} plus free margin. It leaves out token holdings, pool claims and margin already in positions.</Hint>
          </h2>
          <p className={styles.primaryValue}>
            <Sensitive>{amount(f.available, f)}</Sensitive>
            <span className={styles.unit}>{f.symbol}</span>
          </p>
          {stale ? <p className={`t-small warn ${styles.stale}`}>{`Not updated for ${staleFor}s. These figures may be out of date.`}</p> : null}
        </div>
        {actions ? <div className={styles.primaryActions}>{actions}</div> : null}
      </div>
      <dl className={styles.ledger}>
        <div>
          <dt>In wallet</dt>
          <dd className="num">
            <Sensitive>{amount(f.wallet, f)}</Sensitive>
          </dd>
        </div>
        <div>
          <dt>Free margin</dt>
          <dd className="num">
            <Sensitive>{amount(f.freeMargin, f)}</Sensitive>
          </dd>
        </div>
        <div>
          <dt>In positions</dt>
          <dd className="num">
            <Sensitive>{amount(f.lockedMargin, f)}</Sensitive>
          </dd>
        </div>
        <div>
          <dt>Token holdings, est.</dt>
          <dd className="num">
            <Sensitive>{amount(f.holdingsValue, f)}</Sensitive>
          </dd>
        </div>
        <div>
          <dt>Pool claims, est.</dt>
          <dd className="num">
            <Sensitive>{amount(f.lpClaimValue, f)}</Sensitive>
          </dd>
        </div>
        <div className={styles.exposure}>
          <dt>
            Open exposure
            <Hint label="About exposure">Position size at the oracle mark. It is leverage, not money you hold, so it is never added to your balance.</Hint>
          </dt>
          <dd className="num">
            <Sensitive>{amount(f.exposure, f)}</Sensitive>
          </dd>
        </div>
        <div>
          <dt>Unrealised PnL</dt>
          <dd className={`num ${pnlTone ?? ""}`}>
            <Sensitive>{amount(f.unrealizedPnl, f, { sign: "always" })}</Sensitive>
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function AccountSummarySkeleton() {
  return (
    <section className={styles.summary} aria-busy="true" aria-label="Reading account">
      <div className={styles.primary}>
        <div className={styles.primaryText}>
          <Skeleton width={120} height={14} />
          <Skeleton width={280} height={56} />
        </div>
      </div>
      <dl className={styles.ledger}>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i}>
            <dt>
              <Skeleton width={70} height={12} />
            </dt>
            <dd>
              <Skeleton width={90} height={16} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function AccountUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <StateBlock
      kind="unavailable"
      title="Your balances are unavailable"
      body="Rooq couldn't read this account from the chain. Your funds are unaffected. Nothing is shown as zero, because we don't know yet."
      actions={
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      }
    />
  );
}
