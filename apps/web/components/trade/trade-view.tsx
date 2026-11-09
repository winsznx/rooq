"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { copy } from "@rooq/ui";
import { usePrivate } from "@/lib/private/client";
import { findListed, listedMarkets } from "@/lib/private/market-list";
import { useHideValues } from "@/lib/preferences";
import { PrivatePerpsTicket, PrivateTray, usePrivateLevels } from "@/components/private/trade";
import { PrivateSpotTicket } from "@/components/private/spot";
import { Skeleton, StateBlock, Tabs, tabId, tabPanelId } from "../primitives";
import { Menu } from "../icons";
import { useShell } from "../shell/app-shell";
import { MarketHeader, type Mode } from "./market-header";
import { MarketFacts } from "./market-facts";
import { PrivateChart } from "./private-chart";
import styles from "./trade.module.css";

type Section = "chart" | "trade" | "position";
export const LAST_MARKET_KEY = "rooq-last-market";

export function TradeView({ marketKey, mode: requestedMode }: { marketKey: string; mode: Mode }) {
  const { view, offline } = usePrivate();
  const markets = useMemo(() => (view ? listedMarkets(view) : null), [view]);
  const shell = useShell();
  const [section, setSection] = useState<Section>("trade");
  const [factsOpen, setFactsOpen] = useState(false);
  const [trayTab, setTrayTab] = useState<"positions" | "locks">("positions");
  const m = markets ? findListed(markets, marketKey) : undefined;
  const mode: Mode = requestedMode === "perps" && m && !m.market ? "spot" : requestedMode === "spot" && m && !m.pool ? "perps" : requestedMode;

  useEffect(() => {
    if (!m) return;
    try {
      window.localStorage.setItem(LAST_MARKET_KEY, JSON.stringify({ key: m.key, mode }));
    } catch (error) {
      console.warn("last market not stored", error);
    }
  }, [m, mode]);

  const privateMarket = m?.market ?? null;
  const hidden = useHideValues();
  const levels = usePrivateLevels(mode === "perps" ? privateMarket : null, hidden);

  if (!markets) {
    return (
      <div className={styles.stateWrap}>
        {offline ? <StateBlock kind="unavailable" title="This market can't be read right now" body="The private services can't be reached. Prices and balances aren't shown until they can be verified." /> : <><Skeleton width="60%" height={28} /><p className="muted t-small">Reading market state from the chain.</p></>}
      </div>
    );
  }
  if (!m) {
    return (
      <div className={styles.stateWrap}>
        <StateBlock kind="empty" title="Market not found" body="This market isn't in the private deployment." actions={<Link className="btn" href="/app/markets">{copy.portfolio.openMarket}</Link>} />
      </div>
    );
  }

  const perps = mode === "perps";
  const positionsLabel = "Positions";
  const sections = [
    { value: "chart" as const, label: "Chart" },
    { value: "trade" as const, label: copy.nav.trade },
    { value: "position" as const, label: perps ? positionsLabel.replace("Positions", "Position") : "Pool" },
  ];

  return (
    <div className={styles.page} data-mode={mode}>
      <div className={styles.grid}>
        <div className={styles.headArea}>
          <MarketHeader m={m} mode={mode} factsOpen={factsOpen} onToggleFacts={() => setFactsOpen((o) => !o)} />
          {factsOpen ? <MarketFacts m={m} mode={mode} /> : null}
        </div>

        <div className={styles.sectionBar}>
          <Tabs group="trade-section" label="Trade sections" tabs={sections} value={section} onChange={setSection} block className={styles.sectionTabs} />
          <button type="button" className={styles.menuButton} onClick={shell.openMenu}>
            <Menu size={20} />
            <span>Menu</span>
          </button>
        </div>

        <div className={styles.chartArea} data-section-hidden={section !== "chart"} role="tabpanel" id={tabPanelId("trade-section", "chart")} aria-labelledby={tabId("trade-section", "chart")}>
          <PrivateChart key={m.key} history={privateMarket?.history ?? []} levels={levels} />
        </div>

        <div className={styles.ticketArea} data-section-hidden={section !== "trade"} role="tabpanel" id={tabPanelId("trade-section", "trade")} aria-labelledby={tabId("trade-section", "trade")}>
          <section className={styles.ticketPanel} aria-label={perps ? "Perpetual order ticket" : "Spot order ticket"}>
            {perps ? <PrivatePerpsTicket key={m.key} m={m} /> : <PrivateSpotTicket key={m.key} m={m} />}
          </section>
        </div>

        <div className={styles.trayArea} data-section-hidden={section !== "position"} role="tabpanel" id={tabPanelId("trade-section", "position")} aria-labelledby={tabId("trade-section", "position")}>
          <section className={styles.tray} aria-label={perps ? copy.portfolio.positions : "Your pool position"}>
            <Tabs
              group="trade-tray"
              label="Position tray"
              tabs={[
                { value: "positions" as const, label: positionsLabel },
                { value: "locks" as const, label: "Waiting for a match" },
              ]}
              value={trayTab}
              onChange={setTrayTab}
              className={styles.trayTabs}
            />
            <div className={styles.trayBody} role="tabpanel" id={tabPanelId("trade-tray", trayTab)} aria-labelledby={tabId("trade-tray", trayTab)}>
              <PrivateTray market={privateMarket} kind={trayTab} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
