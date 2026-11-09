"use client";

import Image from "next/image";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LayoutGroup, motion } from "motion/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { logoPlate } from "@rooq/config";
import { shortAddress } from "@rooq/sdk";
import { addressUrl } from "@/lib/env";
import { Copy, External, Info } from "./icons";
import { copy } from "@rooq/ui";
import { TRANSITION } from "@/lib/motion";
import { useHideValues } from "@/lib/preferences";

export type PerpStatusName = "NONE" | "REGISTERED" | "ACTIVE" | "CLOSE_ONLY" | "PAUSED" | "SETTLEMENT_PENDING" | "SETTLED";

/** Shape plus text: a filled dot, hollow square, pause bars or warning triangle. Never colour alone. */
function StatusShape({ kind }: { kind: "active" | "closeOnly" | "paused" | "stale" | "off" }) {
  if (kind === "active") {
    return (
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <circle cx="4" cy="4" r="3.5" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "closeOnly") {
    return (
      <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
        <rect x="1" y="1" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === "paused") {
    return (
      <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
        <rect x="1" y="0.5" width="2.25" height="8" fill="currentColor" />
        <rect x="5.75" y="0.5" width="2.25" height="8" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "stale") {
    return (
      <svg width="10" height="9" viewBox="0 0 10 9" aria-hidden>
        <path d="M5 0.75L9.3 8.25H0.7L5 0.75z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
      <path d="M1 4.5h7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function PerpStatusPill({ status, fresh }: { status: PerpStatusName | null; fresh: boolean | null }) {
  if (status === "ACTIVE" && fresh === false) {
    return (
      <span className="pill" data-tone="warning">
        <StatusShape kind="stale" />
        Price delayed
      </span>
    );
  }
  switch (status) {
    case "ACTIVE":
      return (
        <span className="pill" data-tone="positive">
          <StatusShape kind="active" />
          {copy.system.active}
        </span>
      );
    case "CLOSE_ONLY":
      return (
        <span className="pill" data-tone="warning">
          <StatusShape kind="closeOnly" />
          {copy.system.closeOnly}
        </span>
      );
    case "PAUSED":
      return (
        <span className="pill" data-tone="warning">
          <StatusShape kind="paused" />
          Paused
        </span>
      );
    case "SETTLEMENT_PENDING":
      return (
        <span className="pill" data-tone="warning">
          <StatusShape kind="paused" />
          Settling
        </span>
      );
    case "REGISTERED":
      return (
        <span className="pill" data-tone="neutral">
          <StatusShape kind="off" />
          Needs backing
        </span>
      );
    case "SETTLED":
      return (
        <span className="pill" data-tone="neutral">
          <StatusShape kind="off" />
          Settled
        </span>
      );
    default:
      return (
        <span className="pill" data-tone="neutral">
          <StatusShape kind="off" />
          {copy.system.unavailable}
        </span>
      );
  }
}

export function SpotStatusPill({ status, funded }: { status: "NONE" | "ACTIVE" | "PAUSED" | null; funded: boolean }) {
  if (status === "PAUSED") {
    return (
      <span className="pill" data-tone="warning">
        <StatusShape kind="paused" />
        Paused
      </span>
    );
  }
  if (status === "ACTIVE" && funded) {
    return (
      <span className="pill" data-tone="positive">
        <StatusShape kind="active" />
        {copy.system.active}
      </span>
    );
  }
  return (
    <span className="pill" data-tone="neutral">
      <StatusShape kind="off" />
      {status === "ACTIVE" ? "No liquidity" : copy.system.unavailable}
    </span>
  );
}

export function TestTag({ children = copy.system.beta }: { children?: ReactNode }) {
  return (
    <span className="tag" data-tone="test">
      {children}
    </span>
  );
}

/**
 * Asset identity. Verified canonical assets show their issuer artwork from the official CDN;
 * everything else gets a neutral geometric mark for its asset class, never a letter tile.
 */
export function AssetEmblem({
  logoUrl,
  assetClass,
  size = 32,
  label,
}: {
  logoUrl: string | null;
  assetClass: "stock-token" | "stablecoin" | "crypto" | "test-fixture";
  size?: 24 | 32 | 40;
  label: string;
}) {
  const [failed, setFailed] = useState(false);
  const plate = logoUrl ? logoPlate(logoUrl) : null;
  if (logoUrl && !failed && plate) {
    const mark = Math.round(size * 0.62);
    return (
      <span
        style={{ display: "inline-grid", placeItems: "center", flex: "none", width: size, height: size, borderRadius: size / 2, background: plate, boxShadow: "inset 0 0 0 1px var(--rq-line)" }}
      >
        <Image src={logoUrl} alt={label} width={mark} height={mark} style={{ objectFit: "contain" }} onError={() => setFailed(true)} />
      </span>
    );
  }
  if (logoUrl && !failed) {
    return (
      <Image
        src={logoUrl}
        alt={label}
        width={size}
        height={size}
        style={{ borderRadius: size / 2, border: "1px solid var(--rq-line)", background: "var(--rq-surface)" }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={`${label}, unverified artwork`}>
      <title>{`${label}: no verified artwork`}</title>
      <circle cx="16" cy="16" r="15.25" fill="var(--rq-surface-raised)" stroke="var(--rq-line-strong)" strokeWidth="1.5" />
      {assetClass === "stablecoin" ? (
        <path d="M10 16h12M16 10v12" stroke="var(--rq-ink-tertiary)" strokeWidth="1.75" strokeLinecap="round" />
      ) : assetClass === "crypto" ? (
        <path d="M16 9l6 7-6 7-6-7 6-7z" fill="none" stroke="var(--rq-ink-tertiary)" strokeWidth="1.75" strokeLinejoin="round" />
      ) : assetClass === "stock-token" ? (
        <path d="M10.5 21V13M16 21V10M21.5 21v-5" stroke="var(--rq-ink-tertiary)" strokeWidth="1.75" strokeLinecap="round" />
      ) : (
        <rect x="11" y="11" width="10" height="10" rx="1" fill="none" stroke="var(--rq-ink-tertiary)" strokeWidth="1.75" strokeDasharray="2.5 2" />
      )}
    </svg>
  );
}

export function Address({ value, explorer = true, hideText = false }: { value: `0x${string}`; explorer?: boolean; hideText?: boolean }) {
  const [copied, setCopied] = useState(false);
  const url = explorer ? addressUrl(value) : null;
  return (
    <span className="row" style={{ "--gap": "4px" } as React.CSSProperties}>
      {hideText ? null : (
        <span className="num t-small" title={value}>
          {shortAddress(value)}
        </span>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        style={{ minHeight: 28, width: 28 }}
        aria-label={copied ? "Address copied" : `Copy address ${value}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Copy size={16} />
      </button>
      {url ? (
        <a className="btn btn-ghost btn-icon" style={{ minHeight: 28, width: 28 }} href={url} target="_blank" rel="noreferrer" aria-label="View on explorer">
          <External size={16} />
        </a>
      ) : null}
    </span>
  );
}

export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" className="hint" aria-label={label}>
          <Info size={14} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6} collisionPadding={12}>
          {children}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Skeleton({ width, height = 14 }: { width: number | string; height?: number }) {
  return <span className="skeleton" style={{ display: "inline-block", width, height }} aria-hidden />;
}

function SelectionFill() {
  return <motion.span layoutId="selection-fill" className="seg-fill" aria-hidden transition={TRANSITION.select} />;
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly disabled?: boolean;
  /** Why this option is unavailable. Required wording whenever `disabled` is set. */
  readonly reason?: string;
}

/** Filter and mode selector: button-group semantics, the shared selection marker. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  block = false,
}: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  block?: boolean;
}) {
  const scope = useId();
  return (
    <LayoutGroup id={scope}>
      <div className={block ? "seg seg-block" : "seg"} role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={value === o.value} disabled={o.disabled} title={o.disabled ? o.reason : undefined} onClick={() => onChange(o.value)}>
            {o.label}
            {value === o.value ? <SelectionFill /> : null}
          </button>
        ))}
      </div>
    </LayoutGroup>
  );
}

export const tabPanelId = (group: string, tab: string) => `${group}-panel-${tab}`;
export const tabId = (group: string, tab: string) => `${group}-tab-${tab}`;

/** WAI-ARIA tabs: roving tabindex, arrow, Home and End keys, panels linked by aria-controls. */
export function Tabs<T extends string>({
  group,
  label,
  tabs,
  value,
  onChange,
  block = false,
  className,
}: {
  group: string;
  label: string;
  tabs: readonly { readonly value: T; readonly label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  block?: boolean;
  className?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (index === last ? 0 : index + 1) : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    const target = tabs[next]!.value;
    onChange(target);
    refs.current.get(target)?.focus();
  };
  return (
    <LayoutGroup id={group}>
      <div className={[block ? "seg seg-block" : "seg", className].filter(Boolean).join(" ")} role="tablist" aria-label={label}>
        {tabs.map((t, i) => (
          <button
            key={t.value}
            ref={(el) => {
              if (el) refs.current.set(t.value, el);
              else refs.current.delete(t.value);
            }}
            type="button"
            role="tab"
            id={tabId(group, t.value)}
            aria-selected={value === t.value}
            aria-controls={tabPanelId(group, t.value)}
            tabIndex={value === t.value ? 0 : -1}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {value === t.value ? <SelectionFill /> : null}
          </button>
        ))}
      </div>
    </LayoutGroup>
  );
}

/** A figure the owner can hide from people looking over their shoulder. It changes nothing onchain. */
export function Sensitive({ children }: { children: ReactNode }) {
  const hidden = useHideValues();
  if (hidden) {
    return (
      <span aria-label="Hidden value">
        <span aria-hidden>••••</span>
      </span>
    );
  }
  return <>{children}</>;
}

export type ActionState = "idle" | "working" | "success" | "failure";

/**
 * The financial action button: a stable label while working, a stated reason when disabled, and no
 * second submission while a run is in flight.
 */
export function ActionButton({
  children,
  state = "idle",
  reason,
  variant = "primary",
  size = "lg",
  block = true,
  disabled,
  onClick,
}: {
  children: ReactNode;
  state?: ActionState;
  reason?: string | null;
  variant?: "primary" | "secondary" | "danger";
  size?: "lg" | "md" | "sm";
  block?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const reasonId = useId();
  const cls = ["btn", variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "", size === "lg" ? "btn-lg" : size === "sm" ? "btn-sm" : "", block ? "btn-block" : ""].filter(Boolean).join(" ");
  const off = disabled || state === "working";
  return (
    <div>
      <button type="button" className={cls} disabled={off} aria-busy={state === "working"} aria-describedby={reason ? reasonId : undefined} onClick={onClick}>
        {state === "working" ? <span className="btn-work" aria-hidden /> : null}
        {children}
      </button>
      {reason ? (
        <p id={reasonId} className="btn-reason">
          {reason}
        </p>
      ) : null}
    </div>
  );
}

/** The ruled receipt: what changed, what it cost, what settled. */
export function Receipt({ title, status, children }: { title: ReactNode; status?: ReactNode; children: ReactNode }) {
  return (
    <section className="receipt" aria-label="Receipt">
      <div className="receipt-head">
        <strong>{title}</strong>
        {status ? <span className="t-small muted">{status}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function ReceiptGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="receipt-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function ReceiptRow({ label, value, sub, lead = false, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; lead?: boolean; tone?: "pos" | "neg" | "warn" }) {
  return (
    <div className="receipt-row" data-lead={lead}>
      <span>{label}</span>
      <span className={tone}>
        {value}
        {sub ? <small>{sub}</small> : null}
      </span>
    </div>
  );
}

export function PriceKindTag({ kind }: { kind: "firm" | "reference" | "estimate" }) {
  return (
    <span className="px-tag" data-kind={kind}>
      {kind === "firm" ? "Firm" : kind === "reference" ? "Reference" : "Estimate"}
    </span>
  );
}

/** One composition for every state without data. `kind` keeps empty, locked and unavailable visibly distinct. */
export function StateBlock({ kind, title, body, actions }: { kind: "empty" | "locked" | "loading" | "stale" | "unavailable"; title: string; body?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="state" data-kind={kind} role={kind === "unavailable" ? "alert" : undefined}>
      <p className="state-title">{title}</p>
      {body ? <p className="state-body">{body}</p> : null}
      {actions ? <div className="state-actions">{actions}</div> : null}
    </div>
  );
}

export function NotLiveTag({ children = "Not yet available" }: { children?: ReactNode }) {
  return (
    <span className="tag" data-tone="not-live">
      {children}
    </span>
  );
}
