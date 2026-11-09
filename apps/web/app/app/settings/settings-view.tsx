"use client";

import { useState, useSyncExternalStore } from "react";
import { formatBps, parseDecimal } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { applyTheme, readThemePreference, type ThemePreference } from "@/lib/theme";
import { MAX_SLIPPAGE_BPS, setHideValues, setNotifyOperations, setSlippageBps, toggleWatchlist, useHideValues, useNotifyOperations, useSlippageBps, useWatchlist } from "@/lib/preferences";
import { useMarketSnapshots } from "@/lib/chain-data";
import { Segmented } from "@/components/primitives";
import styles from "./settings.module.css";
import { useToast } from "@/components/feedback/toast";
import { AccountSettings } from "@/components/private/account";

/** ST01. Preferences only. Nothing here can loosen a contract risk check. */
export function SettingsView() {
  const theme: ThemePreference = useSyncExternalStore(
    (cb) => {
      const o = new MutationObserver(cb);
      o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-pref"] });
      return () => o.disconnect();
    },
    readThemePreference,
    () => "system" as ThemePreference,
  );
  const slippage = useSlippageBps();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const hideValues = useHideValues();
  const notify = useNotifyOperations();
  const watchlist = useWatchlist();
  const { data: markets } = useMarketSnapshots();
  const [notifyNote, setNotifyNote] = useState<string | null>(null);

  const toggleNotify = async (on: boolean) => {
    if (!on) {
      setNotifyOperations(false);
      return;
    }
    if (!("Notification" in window)) {
      setNotifyNote("This browser does not support notifications.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setNotifyNote("Notifications are blocked for this site in your browser.");
      return;
    }
    setNotifyNote(null);
    setNotifyOperations(true);
  };

  const saveSlippage = () => {
    const tenthsBps = parseDecimal(text, 2);
    const bps = tenthsBps === null ? null : Number(tenthsBps);
    if (bps === null || bps <= 0 || bps > MAX_SLIPPAGE_BPS) {
      setError("Enter a slippage limit between 0.01% and 5%.");
      return;
    }
    setSlippageBps(bps);
    setError(null);
    setText("");
    toast.notify({ tone: "success", title: "Preferences saved" });
  };

  return (
    <div className={styles.page}>
      <h1 className="app-title">{copy.nav.settings}</h1>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Appearance</h2>
        <div className={styles.body}>
          <Segmented
            label="Theme"
            value={theme}
            onChange={applyTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "Match system" },
            ]}
          />
          <label className={styles.switch}>
            <input type="checkbox" checked={hideValues} onChange={(e) => setHideValues(e.target.checked)} />
            <span>
              <strong>Hide values on screen</strong>
              <span>For people looking over your shoulder. It doesn&apos;t change what is onchain.</span>
            </span>
          </label>
          <p className="muted t-small" style={{ margin: 0 }}>Language: English. Numbers use US formatting with explicit signs.</p>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Trading preferences</h2>
        <div className={styles.body}>
          <p className="muted" style={{ margin: 0 }}>{`Slippage limit ${formatBps(slippage)}. Swaps revert if you would receive less than this allows. Perps use the maker's fixed quote price instead.`}</p>
          <div className="field" style={{ maxWidth: 320 }}>
            <label className="field-label" htmlFor="slip">
              New limit
            </label>
            <div className="input-wrap" data-invalid={Boolean(error)}>
              <input id="slip" inputMode="decimal" placeholder="0.50" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "slip-err" : undefined} />
              <span className="unit">%</span>
            </div>
            {error ? (
              <p id="slip-err" className="field-error" role="alert" style={{ margin: 0 }}>
                {error}
              </p>
            ) : null}
          </div>
          <div>
            <button type="button" className="btn btn-primary" onClick={saveSlippage}>
              Save preferences
            </button>
          </div>
          <div className="field">
            <span className="field-label">Watchlist, saved in this browser only</span>
            {watchlist.length === 0 ? (
              <p className="muted t-small" style={{ margin: 0 }}>No saved markets. Use the star on any market.</p>
            ) : (
              <ul className={styles.watch} role="list">
                {watchlist.map((key) => (
                  <li key={key}>
                    <span>{markets?.find((m) => m.deployed.key === key)?.base.symbol ?? key}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleWatchlist(key)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <AccountSettings />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Notifications</h2>
        <div className={styles.body}>
          <label className={styles.switch}>
            <input type="checkbox" checked={notify} onChange={(e) => void toggleNotify(e.target.checked)} />
            <span>
              <strong>Tell me when an operation finishes</strong>
              <span>Browser notification while Rooq is in the background. It never includes amounts or positions. Off by default.</span>
            </span>
          </label>
          {notifyNote ? <p className="field-error" role="alert" style={{ margin: 0 }}>{notifyNote}</p> : null}
        </div>
      </section>
    </div>
  );
}
