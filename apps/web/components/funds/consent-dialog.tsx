"use client";

import { useState } from "react";
import { copy } from "@rooq/ui";
import { Dialog } from "../feedback/dialog";

export const CONSENT_VERSION = "v1";
export function consentKey(address: string): string {
  return `rooq-leverage-consent-${CONSENT_VERSION}:${address.toLowerCase()}`;
}
export function hasConsent(address: string | undefined): boolean {
  if (!address) return false;
  try {
    return window.localStorage.getItem(consentKey(address)) === "accepted";
  } catch (error) {
    console.warn("consent storage unavailable", error);
    return false;
  }
}

/**
 * AC03. Three unchecked statements, exact copy, before the first leveraged quote. Stored per wallet and
 * per consent version. Contract risk checks apply whether or not this was accepted.
 */
export function ConsentDialog({
  open,
  address,
  onAccept,
  onBack,
}: {
  open: boolean;
  address: string;
  onAccept: () => void;
  onBack: () => void;
}) {
  const [checks, setChecks] = useState([false, false, false]);
  const statements = [copy.leverageConsent.ack1, copy.leverageConsent.ack2, copy.leverageConsent.ack3];
  const all = checks.every(Boolean);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onBack();
      }}
      title={copy.leverageConsent.title}
      description={copy.leverageConsent.body}
      fullscreenOnMobile
      footer={
        <>
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={!all}
            onClick={() => {
              try {
                window.localStorage.setItem(consentKey(address), "accepted");
              } catch (error) {
                console.warn("consent not persisted", error);
              }
              onAccept();
            }}
          >
            {copy.leverageConsent.continue}
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
            {copy.leverageConsent.back}
          </button>
        </>
      }
    >
      <fieldset className="consent">
        <legend className="sr-only">Risk acknowledgements</legend>
        {statements.map((text, i) => (
          <label key={text} className="consent-row">
            <input
              type="checkbox"
              checked={checks[i]}
              onChange={(e) => setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
            />
            <span>{text}</span>
          </label>
        ))}
      </fieldset>
      <p className="t-small faint">
        Example only: with 2x leverage, a 10% move against you changes your margin by about 20%, before fees and funding.
      </p>
    </Dialog>
  );
}
