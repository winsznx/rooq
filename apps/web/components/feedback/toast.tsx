"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Close, Info, Warning } from "../icons";

type Tone = "info" | "success" | "warning" | "failure";
interface ToastItem {
  readonly id: number;
  readonly tone: Tone;
  readonly title: string;
  readonly body?: string;
}

interface ToastApi {
  notify: (toast: Omit<ToastItem, "id">) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Toasts never announce PnL as success and never replace a receipt (COMPONENT_SPEC). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const notify = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = Date.now() + Math.random();
      setItems((all) => [...all.slice(-2), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), toast.tone === "failure" ? 9_000 : 5_000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              className="toast"
              data-tone={t.tone}
              role={t.tone === "failure" ? "alert" : "status"}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              {t.tone === "success" ? <Check /> : t.tone === "info" ? <Info /> : <Warning />}
              <div className="toast-text">
                <strong>{t.title}</strong>
                {t.body ? <span>{t.body}</span> : null}
              </div>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <Close size={16} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}
