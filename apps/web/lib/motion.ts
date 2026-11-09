import type { Transition } from "motion/react";

/** The one easing curve in the product. CSS uses the same curve as --rq-ease. */
export const EASE = [0.2, 0.8, 0.2, 1] as const;

/** Durations in seconds. CSS mirrors them as --rq-t-*. Prices and risk figures never use any of these. */
export const DURATION = { press: 0.12, select: 0.18, nav: 0.2, sheet: 0.24, stage: 0.2, story: 0.42 } as const;

export const TRANSITION = {
  select: { duration: DURATION.select, ease: EASE },
  sheet: { duration: DURATION.sheet, ease: EASE },
  stage: { duration: DURATION.stage, ease: EASE },
  story: { duration: DURATION.story, ease: EASE },
} as const satisfies Record<string, Transition>;

/** Opacity-only states for short text and panels whose position does not change. */
export const FADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } as const;
