"use client";

import { useEffect, useRef, type ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { DURATION, TRANSITION } from "@/lib/motion";
import { Close } from "../icons";

/**
 * Modal on desktop (max 520px, radius 12), bottom sheet on phones (full width, up to 92dvh).
 * Radix traps focus, restores it to the trigger and closes on Escape unless `dismissible` is false,
 * which the signing step uses so a wallet prompt cannot be abandoned by accident.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  dismissible = true,
  width = 520,
  fullscreenOnMobile = false,
  placement = "center",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
  width?: number;
  fullscreenOnMobile?: boolean;
  placement?: "center" | "side";
}) {
  // Focus returns to whatever opened the dialog (MOTION_AND_SCROLL: close returns to the triggering control).
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target;
      if (el instanceof HTMLElement && !el.closest("[role='dialog']")) restoreRef.current = el;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => (dismissible || next ? onOpenChange(next) : undefined)}>
      <AnimatePresence>
        {open ? (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div className="dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: DURATION.sheet }} />
            </RadixDialog.Overlay>
            <RadixDialog.Content
              asChild
              forceMount
              onEscapeKeyDown={(e) => {
                if (!dismissible) e.preventDefault();
              }}
              onPointerDownOutside={(e) => {
                if (!dismissible) e.preventDefault();
              }}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                restoreRef.current?.focus();
              }}
            >
              <motion.div
                className="dialog"
                data-fullscreen-mobile={fullscreenOnMobile}
                data-placement={placement}
                style={{ "--dialog-w": `${width}px` } as React.CSSProperties}
                initial={placement === "side" ? { x: 16 } : { y: 12 }}
                animate={{ x: 0, y: 0 }}
                exit={placement === "side" ? { opacity: 0, x: 16 } : { opacity: 0, y: 8 }}
                transition={TRANSITION.sheet}
              >
                <div className="dialog-head">
                  <RadixDialog.Title className="t-panel">{title}</RadixDialog.Title>
                  {dismissible ? (
                    <RadixDialog.Close className="btn btn-ghost btn-icon" aria-label="Close">
                      <Close />
                    </RadixDialog.Close>
                  ) : null}
                </div>
                {description ? (
                  <RadixDialog.Description className="dialog-desc t-small muted">{description}</RadixDialog.Description>
                ) : (
                  <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
                )}
                <div className="dialog-body">{children}</div>
                {footer ? <div className="dialog-foot">{footer}</div> : null}
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
