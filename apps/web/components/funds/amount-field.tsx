"use client";

import { useId } from "react";
import { formatFixed, parseDecimal } from "@rooq/sdk";

/**
 * Decimal amount input. Display text and integer value are kept separately so nothing rounds through
 * floating point. Mobile gets the decimal keypad.
 */
export function AmountField({
  label,
  value,
  onChange,
  decimals,
  unit,
  balanceLabel,
  balance,
  onMax,
  error,
  help,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  decimals: number;
  unit: string;
  balanceLabel?: string;
  balance?: bigint | null;
  onMax?: () => void;
  error?: string | null;
  help?: string;
}) {
  const id = useId();
  const parsed = parseDecimal(value, decimals);
  const invalid = value !== "" && parsed === null;
  const message = invalid ? `Enter an amount with at most ${decimals} decimals.` : error;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        <span>{label}</span>
      </label>
      <div className="input-wrap" data-size="lg" data-invalid={Boolean(message)}>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))}
          aria-invalid={Boolean(message)}
          aria-describedby={message ? `${id}-err` : help ? `${id}-help` : undefined}
         
        />
        {onMax ? (
          <button type="button" className="input-max" onClick={onMax}>
            Max
          </button>
        ) : null}
        <span className="unit">{unit}</span>
      </div>
      {message || help || balanceLabel ? (
        <div className="field-foot">
          {message ? (
            <span id={`${id}-err`} className="field-error" role="alert">
              {message}
            </span>
          ) : help ? (
            <span id={`${id}-help`}>{help}</span>
          ) : (
            <span />
          )}
          {balanceLabel ? (
            <span style={{ whiteSpace: "nowrap" }}>
              {balanceLabel} <span className="num">{balance === undefined || balance === null ? "Unavailable" : formatFixed(balance, decimals, Math.min(decimals, 4))}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
