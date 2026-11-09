import styles from "./brand-mark.module.css";

/**
 * Approved Rooq outlines, copied path for path from 04-BRAND/kit-v1/logos/*-current.svg. Inlined so the mark
 * takes its colour from the surface on first paint. Do not edit the geometry here: change the kit masters.
 */
const MARKS = {
  horizontal: { viewBox: "0 0 720 224", art: <><g transform="translate(8 8) scale(0.8125)"><path fill="currentColor" d="M128 8C66.144 8 16 58.144 16 120s50.144 112 112 112c26.4 0 50.64-9.136 69.76-24.416V248H240v-84H68V88h120v62h47.936A112.402 112.402 0 0 0 240 120C240 58.144 189.856 8 128 8Z"/></g><g transform="translate(244 42) scale(1)"><g fill="currentColor"><path d="M8 120V60c0-30 12-46 32-46 2.21 0 4 1.79 4 4v16C56 15 70 10 88 10h8v24c0 4.418-3.582 8-8 8H77C55 42 38 58 38 80v40Z"/><path fillRule="evenodd" d="M140 8h28c24.301 0 44 19.699 44 44v24c0 24.301-19.699 44-44 44h-28c-24.301 0-44-19.699-44-44V52c0-24.301 19.699-44 44-44Zm5 24h18c12.703 0 23 10.297 23 23v18c0 12.703-10.297 23-23 23h-18c-12.703 0-23-10.297-23-23V55c0-12.703 10.297-23 23-23Z"/><path fillRule="evenodd" d="M252 8h28c24.301 0 44 19.699 44 44v24c0 24.301-19.699 44-44 44h-28c-24.301 0-44-19.699-44-44V52c0-24.301 19.699-44 44-44Zm5 24h18c12.703 0 23 10.297 23 23v18c0 12.703-10.297 23-23 23h-18c-12.703 0-23-10.297-23-23V55c0-12.703 10.297-23 23-23Z"/><path fillRule="evenodd" d="M364 8h28c24.301 0 44 19.699 44 44v24c0 24.301-19.699 44-44 44h-28c-24.301 0-44-19.699-44-44V52c0-24.301 19.699-44 44-44Zm5 24h18c12.703 0 23 10.297 23 23v18c0 12.703-10.297 23-23 23h-18c-12.703 0-23-10.297-23-23V55c0-12.703 10.297-23 23-23Z"/><path d="M410 80h26v58l-26 18Z"/></g></g></> },
  wordmark: { viewBox: "0 0 444 160", art: <><g fill="currentColor"><path d="M8 120V60c0-30 12-46 32-46 2.21 0 4 1.79 4 4v16C56 15 70 10 88 10h8v24c0 4.418-3.582 8-8 8H77C55 42 38 58 38 80v40Z"/><path fillRule="evenodd" d="M140 8h28c24.301 0 44 19.699 44 44v24c0 24.301-19.699 44-44 44h-28c-24.301 0-44-19.699-44-44V52c0-24.301 19.699-44 44-44Zm5 24h18c12.703 0 23 10.297 23 23v18c0 12.703-10.297 23-23 23h-18c-12.703 0-23-10.297-23-23V55c0-12.703 10.297-23 23-23Z"/><path fillRule="evenodd" d="M252 8h28c24.301 0 44 19.699 44 44v24c0 24.301-19.699 44-44 44h-28c-24.301 0-44-19.699-44-44V52c0-24.301 19.699-44 44-44Zm5 24h18c12.703 0 23 10.297 23 23v18c0 12.703-10.297 23-23 23h-18c-12.703 0-23-10.297-23-23V55c0-12.703 10.297-23 23-23Z"/><path fillRule="evenodd" d="M364 8h28c24.301 0 44 19.699 44 44v24c0 24.301-19.699 44-44 44h-28c-24.301 0-44-19.699-44-44V52c0-24.301 19.699-44 44-44Zm5 24h18c12.703 0 23 10.297 23 23v18c0 12.703-10.297 23-23 23h-18c-12.703 0-23-10.297-23-23V55c0-12.703 10.297-23 23-23Z"/><path d="M410 80h26v58l-26 18Z"/></g></> },
  micro: { viewBox: "0 0 16 16", art: <><path fill="currentColor" d="M8 1C4.134 1 1 4.134 1 8c0 3.59 3.134 6 7 6 1.5 0 2.8-.5 4-1.5V15h3v-5H4V6h7v2h4c0-3.866-3.134-7-7-7Z"/></> },
} as const;

export type BrandMarkVariant = keyof typeof MARKS;

/** Decorative by design: the link or heading around it carries the accessible name. */
export function BrandMark({ variant, className, surface }: { variant: BrandMarkVariant; className?: string; surface?: "light" }) {
  const { viewBox, art } = MARKS[variant];
  return (
    <svg className={[styles.mark, styles[variant], className].filter(Boolean).join(" ")} data-surface={surface} viewBox={viewBox} aria-hidden="true" focusable="false">
      {art}
    </svg>
  );
}
