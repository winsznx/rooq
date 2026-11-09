"use client";

import { useId, useState } from "react";

/** One-question check. It teaches; it never gates access to trading. */
export function KnowledgeCheck({ question, options, answer, explanation }: { question: string; options: readonly string[]; answer: number; explanation: string }) {
  const id = useId();
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <fieldset className="panel panel-pad" style={{ border: "1px solid var(--rq-line)", margin: "16px 0" }}>
      <legend className="t-label" style={{ padding: "0 4px" }}>
        Check your understanding
      </legend>
      <p style={{ marginTop: 0, color: "var(--rq-ink)" }}>{question}</p>
      <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
        {options.map((o, i) => (
          <label key={o} className="consent-row" style={{ gridTemplateColumns: "20px 1fr" }}>
            <input type="radio" name={id} checked={picked === i} onChange={() => setPicked(i)} />
            <span>{o}</span>
          </label>
        ))}
      </div>
      {picked !== null ? (
        <p role="status" className={picked === answer ? "pos" : "warn"} style={{ marginBottom: 0 }}>
          {picked === answer ? "Correct. " : "Not quite. "}
          <span className="muted">{explanation}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
