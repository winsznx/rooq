"use client";


import { StateBlock } from "@/components/primitives";
import { txUrl } from "@/lib/env";
import type { ActivityEntry } from "@/lib/private/types";
import { ensureAccount } from "@/lib/private/client";
import { IconRow, Line, Offline, PageHead, PV, ServiceNotice, styles, SyncBadge, useView } from "./kit";

function saveReceipt(entry: ActivityEntry) {
  const blob = new Blob([JSON.stringify({ title: entry.title, detail: entry.detail, block: entry.block?.toString() ?? null, tx: entry.tx, fields: entry.fields, note: "A receipt you chose to export. It doesn't include your keys or other activity." }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rooq-receipt-${entry.id.replace(/[^a-z0-9-]/gi, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function Body() {
  const view = useView();
  if (!view) return <Offline title="Private activity" />;
  return (
    <div className={styles.page}>
      <PageHead title="Private activity" sub="Rebuilt on this device from chain data with your keys. Nobody else can read these details." actions={<SyncBadge />} />
      <ServiceNotice />
      {!view.unlocked ? (
        <StateBlock kind="locked" title="Your activity is private" body="Open your account to rebuild it on this device." actions={<button type="button" className="btn btn-sm" onClick={() => void ensureAccount()}>Open account</button>} />
      ) : view.activity.length === 0 ? (
        <StateBlock kind="empty" title="No activity yet" body="Shield funds to start." />
      ) : (
        <ol className={styles.ledger} data-testid="activity-list">
          {view.activity.map((e) => (
            <li key={e.id}>
              <details>
                <summary>
                  <span className={styles.row}><IconRow view={view} icons={e.icons} /><strong><PV plain>{e.title}</PV></strong></span>
                  <span className="muted t-small">{e.block !== null ? `Block ${e.block}` : ""}</span>
                </summary>
                <div className={styles.ledgerBody}>
                  <p className={styles.note}>{e.detail}</p>
                  {e.fields.map((f) => <Line key={f.label} label={f.label}><PV>{f.value}</PV></Line>)}
                  {e.tx ? <Line label="Settlement">{txUrl(e.tx) ? <a href={txUrl(e.tx)!} target="_blank" rel="noreferrer">{`${e.tx.slice(0, 10)}…`}</a> : <span className="num">{`${e.tx.slice(0, 10)}…`}</span>}</Line> : null}
                  <p className={styles.note}>{e.tx ? "That link shows the proof landed. It doesn't show this trade." : ""}</p>
                  <button type="button" className="btn btn-sm" onClick={() => saveReceipt(e)}>Save this receipt</button>
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
      <p className={styles.note}>Private receipts are decrypted locally. Saving one writes a single file, for you to share by hand.</p>
    </div>
  );
}

export function PrivateActivity() {
  return <Body />;
}
