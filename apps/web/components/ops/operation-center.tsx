"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAccount, usePublicClient } from "wagmi";
import { formatAge, formatCountdown, shortAddress } from "@rooq/sdk";
import { txUrl } from "@/lib/env";
import { FADE, TRANSITION } from "@/lib/motion";
import { PRIVATE_TRACK, PUBLIC_TRACK, RECOVERY_AFTER_MS, REORG_WATCH_MS, STAGE_META, dismissOperation, isActive, isOwned, needsAttention, patchOperation, sweepOrphans, useOperations, type Operation, type OperationStage } from "@/lib/operations";
import { settlementNote } from "@/lib/tx";
import { useHideValues, useNotifyOperations } from "@/lib/preferences";
import { useChainNow, useNow } from "@/lib/use-now";
import { usePrivate, wallet } from "@/lib/private/client";
import { privatePublicClient } from "@/lib/private/public-client";
import { IconRow } from "../private/kit";
import { Dialog } from "../feedback/dialog";
import { Check, External, Operations as OperationsIcon, Warning } from "../icons";
import styles from "./operations.module.css";

const KIND_LABEL: Record<Operation["kind"], string> = {
  trade: "Trade",
  funds: "Funds movement",
  liquidity: "Liquidity change",
  maker: "Maker capital change",
  market: "Market setup",
  faucet: "Test tokens",
};

const trackOf = (op: Operation) => (op.privateActions ? PRIVATE_TRACK : PUBLIC_TRACK);

/** Connected wallet's operations, newest first. Hidden-value mode replaces labels that contain amounts. */
export function useWalletOperations() {
  const { address } = useAccount();
  const ops = useOperations();
  return useMemo(() => (address ? ops.filter((op) => !op.dismissed && (op.privateActions !== undefined || op.wallet.toLowerCase() === address.toLowerCase())) : ops.filter((op) => !op.dismissed && op.privateActions !== undefined)), [ops, address]);
}

function trackIndex(op: Operation): number {
  const TRACK_ORDER: readonly OperationStage[] = trackOf(op).map((t) => t.stage);
  if (op.stage === "confirmed") return TRACK_ORDER.length - 1;
  const here = TRACK_ORDER.indexOf(op.stage);
  if (here >= 0) return here;
  if (op.privateActions) return op.stage === "waiting" || op.stage === "included" ? TRACK_ORDER.length - 1 : TRACK_ORDER.indexOf("submitted");
  const reached = [...op.steps].reverse().find((s) => s.hash);
  return reached ? TRACK_ORDER.indexOf("submitted") : TRACK_ORDER.indexOf("awaiting_signature");
}

function StageTrack({ op }: { op: Operation }) {
  const at = trackIndex(op);
  const stopped = STAGE_META[op.stage].tone === "stopped" || STAGE_META[op.stage].tone === "warning";
  return (
    <ol className={styles.track} aria-hidden>
      {trackOf(op).map((t, i) => (
        <li key={t.stage} data-state={i < at || op.stage === "confirmed" ? "done" : i === at ? (stopped ? "stopped" : "here") : "todo"}>
          <span>{t.label}</span>
        </li>
      ))}
    </ol>
  );
}

function OperationCard({ op, now, chainNow, hidden }: { op: Operation; now: number; chainNow: number | null; hidden: boolean }) {
  const { view } = usePrivate();
  const meta = STAGE_META[op.stage];
  const active = isActive(op);
  const elapsed = Math.max(0, now - Math.floor(op.createdAt / 1000));
  const left = active && op.quoteExpiresAt !== null && chainNow !== null ? op.quoteExpiresAt - chainNow : null;
  const lastHash = [...op.steps].reverse().find((s) => s.hash)?.hash;
  const url = lastHash ? txUrl(lastHash) : null;
  return (
    <li className={styles.card} data-tone={meta.tone}>
      <div className={styles.cardHead}>
        <strong className="row" style={{ "--gap": "8px" } as React.CSSProperties}>{view && op.icons?.length ? <IconRow view={view} icons={op.icons} /> : null}{hidden ? KIND_LABEL[op.kind] : op.title}</strong>
        <span className={`${styles.age} num`}>{active ? formatAge(elapsed) : formatAge(Math.max(0, now - Math.floor(op.updatedAt / 1000)))}</span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.p key={op.stage} className={styles.stage} {...FADE} transition={TRANSITION.stage}>
          {meta.tone === "done" ? <Check size={14} /> : meta.tone === "active" ? <span className={styles.dot} aria-hidden /> : <Warning size={14} />}
          {meta.label}
        </motion.p>
      </AnimatePresence>
      <StageTrack op={op} />
      <p className={styles.detail}>{op.message ?? meta.detail}</p>
      {op.privateActions?.reason ? <p className={`${styles.detail} num`}>{op.privateActions.reason}</p> : null}
      {op.stage === "confirmed" ? <p className={styles.detail}>{op.finalityNote ?? settlementNote()}</p> : null}
      {left !== null && left > 0 && op.stage === "awaiting_signature" ? <p className={styles.detail}>{`Quote valid for ${formatCountdown(left)}`}</p> : null}
      <div className={styles.actions}>
        {lastHash ? (
          url ? (
            <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer">
              {shortAddress(lastHash)} <External size={14} />
            </a>
          ) : (
            <span className="num t-small muted" title={lastHash}>
              {shortAddress(lastHash)}
            </span>
          )
        ) : null}
        <Link className="btn btn-sm" href={op.href as Route}>
          Back to this screen
        </Link>
        {op.privateActions?.canRetry ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void wallet.retryOp(op.id)}>
            {op.stage === "recovery_required" ? "Resume" : "Retry"}
          </button>
        ) : null}
        {op.privateActions?.offerDirect ? <DirectExit id={op.id} /> : null}
        {op.privateActions?.canCancel && active ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void wallet.cancelOp(op.id)}>
            Cancel
          </button>
        ) : null}
        {!active ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => (op.privateActions ? void wallet.dismissOp(op.id) : dismissOperation(op.id))}>
            Clear
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** Only after the relayer couldn't take a withdrawal, and only after the person has read what it costs them. */
function DirectExit({ id }: { id: string }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return <button type="button" className="btn btn-sm" onClick={() => setAsking(true)}>Withdraw from my wallet</button>;
  }
  return (
    <span className={styles.detail} role="alert">
      Your wallet pays the gas, which publicly links it to this withdrawal.{" "}
      <button type="button" className="btn btn-sm btn-primary" onClick={() => void wallet.directOp(id)}>I understand, withdraw</button>
    </span>
  );
}

const WATCHED: ReadonlySet<OperationStage> = new Set(["submitted", "rechecking", "confirmed"]);

function needsWatching(op: Operation, now: number): boolean {
  if (op.privateActions || isOwned(op.id) || !WATCHED.has(op.stage)) return false;
  return op.stage !== "confirmed" || (now - op.updatedAt < REORG_WATCH_MS && op.steps.some((s) => s.blockHash));
}

/**
 * Reconciles anything this page isn't running against the chain, so a reload never loses a pending claim.
 * Confirmed receipts are re-read for a while too: a block can be replaced, and then "confirmed" is no longer true.
 */
function useReconcile() {
  const wagmiClient = usePublicClient();
  const ops = useOperations();
  const now = useNow();
  const latestOps = useRef(ops);
  useEffect(() => {
    latestOps.current = ops;
  }, [ops]);
  useEffect(() => {
    sweepOrphans(now * 1000);
  }, [now]);
  const watchedIds = ops.filter((op) => needsWatching(op, now * 1000)).map((op) => op.id);
  const watchKey = watchedIds.join(",");
  useEffect(() => {
    if (!wagmiClient || !watchKey) return;
    let cancelled = false;
    const check = async () => {
      const ids = new Set(watchKey.split(","));
      for (const op of latestOps.current.filter((o) => ids.has(o.id))) {
        const client = op.privateChain ? privatePublicClient : wagmiClient;
        const updates = await Promise.all(
          op.steps.map(async (s) => {
            if (!s.hash) return s;
            try {
              const receipt = await client.getTransactionReceipt({ hash: s.hash });
              return { ...s, stage: receipt.status === "success" ? ("confirmed" as const) : ("failed" as const), blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, message: undefined };
            } catch (error) {
              if (!(error instanceof Error) || error.name !== "TransactionReceiptNotFoundError") throw error;
              return { ...s, stage: "rechecking" as const, blockNumber: undefined, blockHash: undefined };
            }
          }),
        ).catch((error: unknown) => {
          console.warn("rooq: receipt check failed", error);
          return null;
        });
        if (cancelled || !updates) return;
        const missing = updates.some((s) => s.stage === "rechecking");
        const failed = updates.some((s) => s.stage === "failed");
        const allDone = updates.every((s) => s.stage === "confirmed");
        const age = Date.now() - op.createdAt;
        let stage: OperationStage = op.stage;
        let message: string | null = op.message;
        if (failed) {
          stage = "failed";
          message = null;
        } else if (allDone) {
          stage = "confirmed";
          message = null;
        } else if (missing && age > RECOVERY_AFTER_MS) {
          stage = "recovery_required";
          message = "This transaction is no longer on the chain and hasn't come back. Check your wallet before trying again. Rooq will not resend it.";
        } else if (missing) {
          const wasConfirmed = op.stage === "confirmed" || op.steps.some((s) => s.blockHash);
          stage = wasConfirmed || op.stage === "rechecking" ? "rechecking" : "submitted";
          message = wasConfirmed ? "The block holding this transaction was replaced. Rooq is checking whether it lands again." : op.message;
        } else if (updates.some((s) => s.hash) && !updates.every((s) => s.stage === "confirmed" || s.stage === "not_started")) {
          stage = "recovery_required";
          message = "One transaction confirmed but the sequence stopped before the rest. Check the screen it came from before retrying.";
        }
        const changed = stage !== op.stage || JSON.stringify(updates) !== JSON.stringify(op.steps);
        if (changed) patchOperation(op.id, { steps: updates, stage, finalityNote: stage === "confirmed" ? settlementNote() : null, message });
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [wagmiClient, watchKey]);
}

/**
 * The persistent dock and center. The header button is always present; on phones an extra strip sits
 * above the bottom navigation while something is running. Elapsed time is real; there are no percentages.
 */
export function OperationCenter({ onDockChange }: { onDockChange?: (visible: boolean) => void }) {
  useReconcile();
  const { status } = usePrivate();
  const ops = useWalletOperations();
  const hidden = useHideValues();
  const now = useNow();
  const chainNow = useChainNow();
  const [open, setOpen] = useState(false);
  const active = useMemo(() => ops.filter(isActive), [ops]);
  const attention = ops.filter(needsAttention);
  const lead = active[0] ?? attention[0];
  const recent = ops.filter((op) => !isActive(op));
  const dock = active.length > 0;

  useEffect(() => {
    onDockChange?.(dock);
  }, [dock, onDockChange]);

  const notify = useNotifyOperations();
  const activeIds = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(active.map((op) => op.id));
    const finished = [...activeIds.current].some((id) => !now.has(id));
    activeIds.current = now;
    if (finished && notify && document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("Rooq", { body: "An operation finished. Open Rooq to see the result." });
    }
  }, [active, notify]);

  const announcement = lead ? `${hidden ? KIND_LABEL[lead.kind] : lead.title}: ${STAGE_META[lead.stage].label}` : "";
  const count = active.length;

  return (
    <>
      <button type="button" className={`btn ${styles.headerButton}`} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={count > 0 ? `Operations, ${count} in progress` : "Operations"}>
        <OperationsIcon size={18} />
        <span className={styles.headerLabel}>{lead && isActive(lead) ? STAGE_META[lead.stage].label : "Operations"}</span>
        {count > 0 ? <span className={`${styles.count} num`}>{count}</span> : null}
        {attention.length > 0 && count === 0 ? <Warning size={14} /> : null}
      </button>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {lead && dock ? (
        <div className={styles.dock}>
          <button type="button" className={styles.dockButton} onClick={() => setOpen(true)} aria-haspopup="dialog">
            <span className={styles.dot} aria-hidden />
            <span className={styles.dockText}>
              <strong>{hidden ? KIND_LABEL[lead.kind] : lead.title}</strong>
              <span>{STAGE_META[lead.stage].label}</span>
            </span>
            <span className="num t-small muted">{formatAge(Math.max(0, now - Math.floor(lead.createdAt / 1000)))}</span>
          </button>
        </div>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Operations"
        description="Every action you authorise stays here, with its real stage, until you clear it. You can leave this screen while something runs."
        placement="side"
      >
        <div className={styles.center}>
          {ops.length === 0 ? (
            <p className="muted t-small" style={{ margin: 0 }}>
              Nothing yet. Transactions you approve appear here and survive navigation and reloads.
            </p>
          ) : null}
          {active.length > 0 || attention.length > 0 ? (
            <section aria-label="In progress">
              <h3 className="t-label muted">In progress</h3>
              <ul className={styles.list} role="list">
                {[...active, ...attention.filter((op) => !isActive(op))].map((op) => (
                  <OperationCard key={op.id} op={op} now={now} chainNow={chainNow} hidden={hidden} />
                ))}
              </ul>
            </section>
          ) : null}
          {recent.filter((op) => !needsAttention(op)).length > 0 ? (
            <section aria-label="Recent">
              <h3 className="t-label muted">Recent</h3>
              <ul className={styles.list} role="list">
                {recent
                  .filter((op) => !needsAttention(op))
                  .map((op) => (
                    <OperationCard key={op.id} op={op} now={now} chainNow={chainNow} hidden={hidden} />
                  ))}
              </ul>
            </section>
          ) : null}
          {status === "unlock" || status === "sign" ? (
            <p className="t-small faint" style={{ margin: 0 }}>
              Your private account is locked. Unlock it to see private operations. They are stored encrypted on this device.
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
