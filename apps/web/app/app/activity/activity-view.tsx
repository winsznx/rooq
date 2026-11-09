"use client";

import { useAccount } from "wagmi";
import { shortAddress } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import type { ActivityRow } from "@rooq/sdk";
import { useActivity } from "@/lib/api-hooks";
import { txUrl } from "@/lib/env";
import Link from "next/link";
import { ChevronDown, External } from "@/components/icons";
import { NotLiveTag, Receipt, ReceiptGroup, ReceiptRow, StateBlock } from "@/components/primitives";
import { WalletGate } from "@/components/wallet";
import styles from "./activity.module.css";

const FINALITY: Record<ActivityRow["finality"], string> = {
  local: "Local chain, no Ethereum settlement",
  sequencer: copy.activity.confirmed,
  "l1-pending": copy.activity.l1Pending,
  "l1-final": "Final on Ethereum",
};

function actionName(raw: string): string {
  const words = raw.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function statusOf(row: ActivityRow): { text: string; tone?: "warn" | "neg" } {
  if (row.state === "reverted") return { text: copy.activity.failed, tone: "neg" };
  if (row.state === "rechecking" || !row.canonical) return { text: "Receipt rechecking", tone: "warn" };
  return { text: FINALITY[row.finality] };
}

/** P03. Chain receipts only; an L2 receipt and Ethereum finality are shown as different things. */
export function ActivityView() {
  const { address } = useAccount();
  const { data, isLoading, isError, refetch } = useActivity(address);
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{copy.activity.title}</h1>
      {!address ? (
        <StateBlock kind="locked" title="Connect a wallet to see its activity" actions={<WalletGate><span /></WalletGate>} />
      ) : isError ? (
        <StateBlock
          kind="unavailable"
          title="Activity is unavailable"
          body="The indexer API is not responding. Your balances and positions on other pages still come straight from the chain."
          actions={<button type="button" className="btn btn-sm" onClick={() => void refetch()}>{copy.activity.retry}</button>}
        />
      ) : isLoading ? (
        <StateBlock kind="loading" title="Loading indexed activity" />
      ) : !data || data.items.length === 0 ? (
        <StateBlock kind="empty" title={copy.activity.empty} actions={<Link href="/app/markets" className="btn btn-sm">{copy.portfolio.openMarket}</Link>} />
      ) : (
        <ol className={styles.ledger}>
          {data.items.map((row, i) => {
            const url = txUrl(row.txHash);
            const status = statusOf(row);
            return (
              <li key={`${row.txHash}-${row.action}-${i}`} style={row.canonical ? undefined : { opacity: 0.6 }}>
                <details className={styles.entry}>
                  <summary className={styles.summary}>
                    <span className={styles.summaryText}>
                      <strong>{actionName(row.action)}</strong>
                      <span>{row.summary}</span>
                    </span>
                    <span className={`${styles.status} ${status.tone ?? ""}`}>{status.text}</span>
                    <ChevronDown size={16} aria-hidden />
                  </summary>
                  <div className={styles.receipt}>
                    <Receipt title={actionName(row.action)} status={status.text}>
                      <ReceiptGroup title="What settled">
                        <ReceiptRow label="Summary" value={<span style={{ fontFamily: "var(--rq-font-ui-stack)" }}>{row.summary}</span>} />
                        <ReceiptRow label="Block" value={row.blockNumber} />
                        <ReceiptRow
                          label="Transaction"
                          value={
                            url ? (
                              <a href={url} target="_blank" rel="noreferrer" className="row" style={{ "--gap": "4px" } as React.CSSProperties}>
                                {shortAddress(row.txHash)}
                                <External size={14} />
                              </a>
                            ) : (
                              <span title={row.txHash}>{shortAddress(row.txHash)}</span>
                            )
                          }
                        />
                        <ReceiptRow label="Finality" value={status.text} />
                      </ReceiptGroup>
                    </Receipt>
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      )}
      <p className="t-small faint" style={{ margin: 0 }}>
        Public onchain activity for this wallet. <NotLiveTag /> Private receipts and scoped sharing arrive with private V1.
      </p>
    </div>
  );
}
