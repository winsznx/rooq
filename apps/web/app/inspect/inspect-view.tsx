"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { InspectError, inspectTransaction, isTxHash, type InspectResult, type Party } from "@/lib/inspect/inspect";
import { addressUrl, txUrl } from "@/lib/env";
import styles from "./inspect.module.css";

const EXAMPLES = [
  { label: "A Rooq swap", hash: "0x86a4421bae76f8e6cb5ec4ae3b9d7e96b1ed60bd8becc48dc3689072a22a9552" },
  { label: "A Rooq perp close", hash: "0x1d1907cc4ebdc6d77a9d25f337c51a0cb5d6d4c0c78bf1273dedd4967975a538" },
  { label: "A Rooq deposit", hash: "0x1f8ce1f24500bc557f9336559471fa3b31d9696f8f39597fb37fdfb0b21db3ff" },
  { label: "A public swap on another app", hash: "0x9c2df19984b4e36a71401026b29ff697759e15dfca331a8243390c64b0d8d0f7" },
] as const;

const ERROR_TEXT: Record<InspectError["reason"], string> = {
  BAD_HASH: "That isn't a transaction hash. It should start with 0x and have 64 more characters.",
  NOT_FOUND: "No transaction with that hash on Robinhood Chain testnet. Check the network and the hash.",
  RPC_FAILED: "Couldn't reach the testnet RPC. Try again in a moment.",
};

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function PartyView({ party }: { party: Party }) {
  const href = addressUrl(party.address);
  const text = party.label ? `${party.label} (${short(party.address)})` : short(party.address);
  return href ? <a href={href} target="_blank" rel="noreferrer" className="num">{text}</a> : <span className="num">{text}</span>;
}

function Summary({ r }: { r: InspectResult }) {
  const href = txUrl(r.hash);
  return (
    <dl className={styles.summary}>
      <div><dt>Status</dt><dd>{r.status === "success" ? "Confirmed" : "Reverted"}</dd></div>
      <div><dt>Time</dt><dd className="num">{new Date(r.timestamp * 1000).toUTCString().replace(" GMT", " UTC")}</dd></div>
      <div><dt>Sent by</dt><dd><PartyView party={r.from} /></dd></div>
      <div><dt>To</dt><dd>{r.to ? <PartyView party={r.to} /> : "Contract creation"}</dd></div>
      <div><dt>Data sent</dt><dd className="num">{r.inputBytes.toLocaleString("en-US")} bytes</dd></div>
      <div><dt>Block</dt><dd className="num">{href ? <a href={href} target="_blank" rel="noreferrer">{r.block.toString()}</a> : r.block.toString()}</dd></div>
    </dl>
  );
}

function RooqResult({ r, rooq }: { r: InspectResult; rooq: NonNullable<InspectResult["rooq"]> }) {
  const { facts, values, opaque } = rooq;
  const relayed = r.from.label !== null && r.from.label !== "Rooq deployer";
  return (
    <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
      <p className={styles.kicker}>Rooq · {rooq.contract} · {facts.label}</p>
      <div className={styles.split}>
        <section className={styles.public} aria-label="On the public chain">
          <h2>On the public chain</h2>
          <ul>{facts.onChain.map((f) => <li key={f}>{f}</li>)}</ul>
          {values.length ? (
            <dl className={styles.values}>{values.map((v) => <div key={`${v.label}-${v.value}`}><dt>{v.label}</dt><dd className="num">{v.party ? <PartyView party={v.party} /> : v.value}</dd></div>)}</dl>
          ) : null}
          {opaque.length ? (
            <dl className={styles.values}>{opaque.map((v) => <div key={v.label}><dt>{v.label}</dt><dd>{v.value}</dd></div>)}</dl>
          ) : null}
          {relayed ? <p className={styles.note}>Sent by a Rooq service, so the trader&apos;s own wallet never appears.</p> : null}
        </section>
        <section className={styles.private} aria-label="Not on the chain">
          <h2>Not on the chain</h2>
          {facts.offChain.length ? <ul>{facts.offChain.map((f) => <li key={f}>{f}</li>)}</ul> : <p className="muted">Nothing. This action is public by design.</p>}
          <p className={styles.note}>The trader&apos;s own receipt, decrypted on their device, holds these details.</p>
        </section>
      </div>
    </div>
  );
}

function PublicResult({ r }: { r: InspectResult }) {
  return (
    <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
      <p className={styles.kicker}>Not a Rooq transaction</p>
      <section className={styles.public} aria-label="Everything here is public">
        <h2>Everything here is public</h2>
        {r.transfers.length ? (
          <ul className={styles.transfers}>
            {r.transfers.map((t, i) => (
              <li key={`${t.token}-${i}`}><strong className="num">{t.amount}</strong> from <PartyView party={t.from} /> to <PartyView party={t.to} /></li>
            ))}
          </ul>
        ) : (
          <p className="muted">No token transfers in this transaction. Its sender, target and data are still public.</p>
        )}
        <p className={styles.note}>Anyone can read the amounts and wallets above, and follow those wallets to everything else they&apos;ve done.</p>
      </section>
      <p className="muted">On Rooq, a private swap shows only that a pool changed. <Link href={`/inspect?tx=${EXAMPLES[0].hash}`}>Compare a Rooq swap</Link>.</p>
    </div>
  );
}

export function InspectView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const active = params.get("tx") ?? "";
  const [draft, setDraft] = useState(active);
  const query = useQuery({
    queryKey: ["inspect", active.toLowerCase()],
    queryFn: () => inspectTransaction(active),
    enabled: isTxHash(active),
    staleTime: Infinity,
    retry: (count, err) => count < 1 && err instanceof InspectError && err.reason === "RPC_FAILED",
  });

  function open(hash: string) {
    setDraft(hash);
    router.replace(`${pathname}?tx=${hash.trim()}`, { scroll: false });
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    open(draft);
  }

  const invalid = draft.trim() !== "" && !isTxHash(draft);
  const error = query.error instanceof InspectError ? ERROR_TEXT[query.error.reason] : query.error ? ERROR_TEXT.RPC_FAILED : null;

  return (
    <div className="stack" style={{ "--gap": "24px" } as React.CSSProperties}>
      <form className={styles.form} onSubmit={submit}>
        <label className="field" style={{ flex: 1 }}>
          <span className="field-label">Transaction hash</span>
          <span className="input-wrap" data-invalid={invalid}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={invalid} />
          </span>
        </label>
        <button type="submit" className="btn btn-primary btn-lg" disabled={!isTxHash(draft)}>Inspect</button>
      </form>
      <div className={styles.examples}>
        <span className="muted t-small">Try one:</span>
        {EXAMPLES.map((ex) => (
          <button key={ex.hash} type="button" className="btn btn-sm" onClick={() => open(ex.hash)} aria-pressed={active === ex.hash}>{ex.label}</button>
        ))}
      </div>

      {active && !isTxHash(active) ? <p className="notice" data-tone="negative">{ERROR_TEXT.BAD_HASH}</p> : null}
      {query.isFetching && !query.data ? <p className="muted">Reading the transaction from Robinhood Chain testnet…</p> : null}
      {error ? <p className="notice" data-tone="negative">{error}</p> : null}
      {query.data ? (
        <div className="stack" style={{ "--gap": "20px" } as React.CSSProperties}>
          <Summary r={query.data} />
          {query.data.rooq ? <RooqResult r={query.data} rooq={query.data.rooq} /> : <PublicResult r={query.data} />}
        </div>
      ) : null}
      <p className="muted t-small">Reads public data from Robinhood Chain testnet in your browser. Nothing you paste is sent to Rooq.</p>
    </div>
  );
}
