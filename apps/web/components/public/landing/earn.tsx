"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight } from "../../icons";
import Image from "next/image";
import { EyeToggle, Masked } from "./masked";
import { TokenLogo } from "./token-logo";
import { TOKENS, TOKEN_MAP, money, type DemoToken } from "./data";
import styles from "./landing.module.css";

type Tab = "pools" | "makers";

/** Example pool sizes and volumes. Labelled on screen; not market data. */
const POOLS: Record<DemoToken["key"], { size: number; monthly: number }> = {
  TSLA: { size: 420_000, monthly: 2_400_000 },
  AMZN: { size: 310_000, monthly: 1_250_000 },
  PLTR: { size: 180_000, monthly: 1_600_000 },
  NFLX: { size: 150_000, monthly: 620_000 },
  AMD: { size: 260_000, monthly: 1_800_000 },
};
const POOL_FEE = 0.0025;
const IMR = 0.5;

export function Earn() {
  const [tab, setTab] = useState<Tab>("pools");
  const [key, setKey] = useState<DemoToken["key"]>("TSLA");
  const [amount, setAmount] = useState(2500);
  const [hidden, setHidden] = useState(false);
  const pools = useRef<HTMLButtonElement>(null);
  const makers = useRef<HTMLButtonElement>(null);
  const pool = POOLS[key];
  const share = (amount / (pool.size + amount)) * 100;
  const monthly = pool.monthly * POOL_FEE * (share / 100);
  const capacity = amount / IMR;

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next: Tab = tab === "pools" ? "makers" : "pools";
    setTab(next);
    (next === "pools" ? pools : makers).current?.focus();
  };

  return (
    <section className={`${styles.carbon} ${styles.earn}`} aria-labelledby="earn">
      <Image src="/art/glow.webp" alt="" fill sizes="100vw" className={styles.earnGlow} />
      <div className={styles.inner}>
        <div className={styles.ownHead}>
          <h2 id="earn" className={styles.h2}>
            Put your money to work
          </h2>
          <p className={styles.lead}>Earn from other people&apos;s trades while your share stays private. Pick a token to see what it could look like.</p>
        </div>

        <div className={styles.earnTabs} role="tablist" aria-label="Ways to earn">
          <button ref={pools} type="button" role="tab" id="earn-tab-pools" aria-controls="earn-panel" aria-selected={tab === "pools"} tabIndex={tab === "pools" ? 0 : -1} onClick={() => setTab("pools")} onKeyDown={onKey}>
            Pools
          </button>
          <button ref={makers} type="button" role="tab" id="earn-tab-makers" aria-controls="earn-panel" aria-selected={tab === "makers"} tabIndex={tab === "makers" ? 0 : -1} onClick={() => setTab("makers")} onKeyDown={onKey}>
            Makers
          </button>
        </div>

        <div id="earn-panel" role="tabpanel" aria-labelledby={`earn-tab-${tab}`} className={styles.earnGrid}>
          <div className={styles.poolList}>
            <p className={styles.poolHead}>
              <span>{tab === "pools" ? "Pool" : "Market to back"}</span>
              <span>{tab === "pools" ? "Size" : "Most leverage"}</span>
              <span>{tab === "pools" ? "Fee" : "Type"}</span>
            </p>
            {TOKENS.map((t) => (
              <div key={t.key} className={styles.poolRow} data-on={key === t.key}>
                <button type="button" className={styles.poolPick} aria-pressed={key === t.key} onClick={() => setKey(t.key)}>
                  <span className="sr-only">Estimate for </span>
                  <TokenLogo symbol={t.key} size={30} />
                  <span>
                    <strong>{tab === "pools" ? `${t.key} / USDG` : t.key}</strong>
                    <small>{t.name}</small>
                  </span>
                  <span className={styles.num}>{tab === "pools" ? `$${money(POOLS[t.key].size, 0)}` : "2.0x"}</span>
                  <span className={styles.num}>{tab === "pools" ? "0.25%" : "Perps"}</span>
                </button>
                <Link href={(tab === "pools" ? `/app/liquidity/${t.key}` : `/app/makers/${t.key}`) as Route} className={styles.poolOpen} aria-label={`Open ${t.key} in the app`}>
                  Open
                  <ChevronRight size={16} />
                </Link>
              </div>
            ))}
          </div>

          <div className={styles.calc}>
            <p className={styles.calcTitle}>
              {key}
              <span className={styles.receiptTools}>
                Example numbers
                <EyeToggle hidden={hidden} onToggle={() => setHidden((h) => !h)} label="your share" />
              </span>
            </p>
            <label className={styles.slider}>
              <span className={styles.sliderHead}>
                <span>{tab === "pools" ? "If you add" : "If you commit"}</span>
                <output data-testid="earn-amount">{`$${money(amount, 0)}`}</output>
              </span>
              <input type="range" min={100} max={25000} step={100} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Amount in dollars" />
            </label>
            {tab === "pools" ? (
              <dl className={styles.rows}>
                <div>
                  <dt>Your private share</dt>
                  <dd data-testid="earn-share">
                    <Masked hidden={hidden}>{`${share.toFixed(2)}%`}</Masked>
                  </dd>
                </div>
                <div>
                  <dt>Example fees a month</dt>
                  <dd data-testid="earn-monthly">
                    <Masked hidden={hidden}>{`$${money(monthly)}`}</Masked>
                  </dd>
                </div>
              </dl>
            ) : (
              <dl className={styles.rows}>
                <div>
                  <dt>Trades you could back</dt>
                  <dd data-testid="earn-capacity">
                    <Masked hidden={hidden}>{`$${money(capacity, 0)}`}</Masked>
                  </dd>
                </div>
                <div>
                  <dt>You can take back</dt>
                  <dd>Anything not in open trades</dd>
                </div>
              </dl>
            )}
            <p className={styles.small}>{tab === "pools" ? `Uses an example ${TOKEN_MAP[key].key} pool and volume. Pool prices move, and you can get back a different mix of tokens. No return is promised.` : "Backing is your money at risk against traders. Testnet money has no value. No return is promised."}</p>
            <Link href={(tab === "pools" ? `/app/liquidity/${key}` : `/app/makers/${key}`) as Route} className="btn btn-primary btn-block">
              {tab === "pools" ? `Open the ${key} pool` : `Back ${key}`}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
