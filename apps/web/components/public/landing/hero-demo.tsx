"use client";

import Link from "next/link";
import type { Route } from "next";
import { useMemo, useState } from "react";
import { Create, Liquidity, Markets, Portfolio, Search, SwapArrows, Trade, Close } from "../../icons";
import { EyeToggle, Masked } from "./masked";
import { PriceChart } from "./price-chart";
import { TokenLogo } from "./token-logo";
import { TIMEFRAMES, TOKENS, TOKEN_MAP, money, series, signedPercent, type DemoToken, type Timeframe } from "./data";
import styles from "./landing.module.css";

type Pane = "trade" | "markets" | "swap" | "portfolio" | "liquidity" | "create";
type Mode = "spot" | "perps";
type Side = "long" | "short";

const PANES: readonly { id: Pane; label: string; short?: string; icon: typeof Trade }[] = [
  { id: "trade", label: "Trade", icon: Trade },
  { id: "markets", label: "Markets", icon: Markets },
  { id: "swap", label: "Swap", icon: SwapArrows },
  { id: "portfolio", label: "Portfolio", icon: Portfolio },
  { id: "liquidity", label: "Liquidity", icon: Liquidity },
  { id: "create", label: "Create market", short: "Create", icon: Create },
];

const SUMMARY: readonly (readonly [string, string])[] = [
  ["Money ready to use", "4,250.00 USDG"],
  ["Money in positions", "180.00 USDG"],
  ["Tokens you own", "2.40 NFLX"],
  ["Your open trades", "1"],
];

const HOLDINGS: readonly { symbol: DemoToken["key"] | "USDG"; note: string; value: string }[] = [
  { symbol: "TSLA", note: "Long 2x", value: "+4.12" },
  { symbol: "NFLX", note: "You own", value: "2.40" },
  { symbol: "USDG", note: "Ready", value: "4,250.00" },
];

const LEVERAGE = [1, 1.5, 2] as const;
const TAKER_FEE = 0.0006;
const POOL_FEE = 0.0025;
const SPREAD = 0.001;
const MAINTENANCE = 0.35;

function parse(text: string): number {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function changeOf(token: DemoToken, tf: Timeframe): number {
  const s = series(token, tf);
  return ((s[s.length - 1]!.c - s[0]!.o) / s[0]!.o) * 100;
}

function Segment<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; text: string }[]; onChange: (v: T) => void }) {
  return (
    <div className={styles.seg} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

function TokenList({ tokens, active, onPick, tf = "1d" }: { tokens: readonly DemoToken[]; active: DemoToken["key"]; onPick: (k: DemoToken["key"]) => void; tf?: Timeframe }) {
  return (
    <ul className={styles.tokenList} role="list">
      {tokens.map((t) => (
        <li key={t.key}>
          <button type="button" aria-pressed={active === t.key} onClick={() => onPick(t.key)}>
            <TokenLogo symbol={t.key} size={24} />
            <span className={styles.tokenName}>{t.key}</span>
            <span className={styles.tokenPrice}>
              {money(t.price)}
              <small className={changeOf(t, tf) >= 0 ? styles.up : styles.down}>{signedPercent(changeOf(t, tf))}</small>
            </span>
          </button>
        </li>
      ))}
      {tokens.length === 0 ? <li className={styles.noResult}>No market matches.</li> : null}
    </ul>
  );
}

export function HeroDemo() {
  const [pane, setPane] = useState<Pane>("trade");
  const [key, setKey] = useState<DemoToken["key"]>("TSLA");
  const [mode, setMode] = useState<Mode>("perps");
  const [side, setSide] = useState<Side>("long");
  const [sizeText, setSizeText] = useState("500");
  const [leverage, setLeverage] = useState<(typeof LEVERAGE)[number]>(2);
  const [tf, setTf] = useState<Timeframe>("1h");
  const [query, setQuery] = useState("");
  const [review, setReview] = useState(false);
  const [swapText, setSwapText] = useState("250");
  const [poolKey, setPoolKey] = useState<DemoToken["key"]>("AMD");
  const [poolText, setPoolText] = useState("1000");
  const [address, setAddress] = useState("");
  const [masked, setMasked] = useState(true);
  const [phoneView, setPhoneView] = useState<"chart" | "order">("chart");

  const token = TOKEN_MAP[key];
  const needle = query.trim().toLowerCase();
  const filtered = TOKENS.filter((t) => t.key.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle));
  const candles = useMemo(() => series(token, tf), [token, tf]);
  const size = parse(sizeText);
  const long = side === "long";
  const yourPrice = token.price * (long ? 1 + SPREAD : 1 - SPREAD);
  const units = size / yourPrice;
  const margin = size / leverage;
  const feePerps = size * TAKER_FEE;
  const liq = long ? (yourPrice * (1 - 1 / leverage)) / (1 - MAINTENANCE) : (yourPrice * (1 + 1 / leverage)) / (1 + MAINTENANCE);
  const feeSpot = size * POOL_FEE;
  const received = (size - feeSpot) / token.price;
  const verb = mode === "perps" ? (long ? "long" : "short") : long ? "buy" : "sell";
  const appHref = `/app/trade/${key}?mode=${mode}` as Route;
  const change = changeOf(token, tf);

  const pickMarket = (k: DemoToken["key"]) => {
    setKey(k);
    setReview(false);
  };
  const toTrade = (k: DemoToken["key"]) => {
    pickMarket(k);
    setPane("trade");
  };

  return (
    <section className={styles.demo} aria-label="Working demo of the Rooq app with example data">
      <div className={styles.demoBar}>
        <label className={styles.demoSearch}>
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search markets" aria-label="Search markets in the demo" />
        </label>
        <span className={styles.demoTag}>Demo, example data</span>
      </div>

      <div className={styles.demoBody}>
        <nav className={styles.demoRail} aria-label="Demo screens">
          {PANES.map((p) => {
            const Icon = p.icon;
            return (
              <button key={p.id} type="button" title={p.label} aria-label={p.label} aria-current={pane === p.id ? "page" : undefined} onClick={() => setPane(p.id)}>
                <Icon size={19} />
                <span>{p.short ?? p.label}</span>
              </button>
            );
          })}
        </nav>

        {pane === "trade" ? (
          <div className={styles.tradePane} data-view={phoneView}>
            <div className={styles.listCol}>
              <p className={styles.colTitle}>Markets</p>
              <TokenList tokens={filtered} active={key} onPick={pickMarket} tf={tf} />
              <Link href={"/app/markets" as Route} className={styles.listMore}>
                All markets
              </Link>
              <div className={styles.holdings} data-testid="demo-holdings">
                <p className={styles.glassHead}>
                  Your holdings
                  <EyeToggle hidden={masked} onToggle={() => setMasked((m) => !m)} label="your holdings" />
                </p>
                {HOLDINGS.map((h) => (
                  <div key={h.symbol}>
                    <TokenLogo symbol={h.symbol} size={20} />
                    <span>
                      {h.symbol}
                      <small>{h.note}</small>
                    </span>
                    <b>
                      <Masked hidden={masked}>{h.value}</Masked>
                    </b>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.phoneSwitch}>
              <Segment label="Chart or order" value={phoneView} options={[{ value: "chart", text: "Chart" }, { value: "order", text: "Order" }]} onChange={setPhoneView} />
            </div>

            <div className={styles.chartCol}>
              <div className={styles.marketHead}>
                <TokenLogo symbol={key} size={30} />
                <h2 className={styles.marketName}>{key}</h2>
                <Segment label="Spot or perps" value={mode} options={[{ value: "spot", text: "Spot" }, { value: "perps", text: "Perps" }]} onChange={setMode} />
                <span className={styles.bigPrice} data-testid="demo-price">
                  {money(token.price)}
                </span>
                <span className={change >= 0 ? styles.up : styles.down}>{signedPercent(change)}</span>
                <div className={styles.tfs}>
                  <Segment label="Timeframe" value={tf} options={TIMEFRAMES.map((t) => ({ value: t, text: t }))} onChange={setTf} />
                </div>
              </div>
              <div className={styles.chartStage}>
                <PriceChart candles={candles} tf={tf} label={`${key} price`} />
              </div>
            </div>

            <div className={styles.ticket}>
              <Segment
                label={mode === "perps" ? "Long or short" : "Buy or sell"}
                value={side}
                options={mode === "perps" ? [{ value: "long", text: "Long" }, { value: "short", text: "Short" }] : [{ value: "long", text: "Buy" }, { value: "short", text: "Sell" }]}
                onChange={setSide}
              />
              <label className={styles.field}>
                <span>{mode === "perps" ? "Size" : "You pay"}</span>
                <span className={styles.input}>
                  <input inputMode="decimal" value={sizeText} onChange={(e) => setSizeText(e.target.value.replace(/[^\d.]/g, ""))} aria-label={mode === "perps" ? "Position size in USDG" : "Amount to pay in USDG"} />
                  <TokenLogo symbol="USDG" size={20} />
                </span>
              </label>
              {mode === "perps" ? (
                <div className={styles.field}>
                  <span>Leverage</span>
                  <div className={styles.lev} role="group" aria-label="Leverage">
                    {LEVERAGE.map((l) => (
                      <button key={l} type="button" aria-pressed={leverage === l} onClick={() => setLeverage(l)}>
                        {`${l}x`}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <dl className={styles.rows} data-testid="ticket-rows">
                {mode === "perps" ? (
                  <>
                    <div>
                      <dt>Your price</dt>
                      <dd data-testid="your-price">{money(yourPrice)}</dd>
                    </div>
                    <div>
                      <dt>You get</dt>
                      <dd>{`${money(units, 4)} ${key}`}</dd>
                    </div>
                    <div>
                      <dt>Money you put up</dt>
                      <dd data-testid="margin">{`${money(margin)} USDG`}</dd>
                    </div>
                    <div>
                      <dt>Fee</dt>
                      <dd data-testid="fee">{`${money(feePerps)} USDG`}</dd>
                    </div>
                    <div>
                      <dt>Closed out near</dt>
                      <dd data-testid="liq">{leverage === 1 && long ? "Close to zero" : money(liq)}</dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <dt>Price</dt>
                      <dd>{money(token.price)}</dd>
                    </div>
                    <div>
                      <dt>You get, about</dt>
                      <dd data-testid="spot-get">{long ? `${money(received, 4)} ${key}` : `${money(size * token.price * (1 - POOL_FEE))} USDG`}</dd>
                    </div>
                    <div>
                      <dt>Fee</dt>
                      <dd>{long ? `${money(feeSpot)} USDG` : `${money(size * POOL_FEE, 4)} ${key}`}</dd>
                    </div>
                    <div>
                      <dt>Can be closed out</dt>
                      <dd>Never</dd>
                    </div>
                  </>
                )}
              </dl>
              <div className={styles.glassAccount} data-testid="glass-account">
                <p className={styles.glassHead}>
                  Your account
                  <EyeToggle hidden={masked} onToggle={() => setMasked((m) => !m)} label="your account" />
                </p>
                <div>
                  <span>Balance</span>
                  <b>
                    <Masked hidden={masked}>4,250.00 USDG</Masked>
                  </b>
                </div>
                <div>
                  <span>Position</span>
                  <b>
                    <Masked hidden={masked}>Long 0.50 TSLA</Masked>
                  </b>
                </div>
                <div>
                  <span>Profit</span>
                  <b>
                    <Masked hidden={masked}>+4.12 USDG</Masked>
                  </b>
                </div>
              </div>
              <button type="button" className="btn btn-primary btn-block" disabled={size === 0} onClick={() => setReview(true)}>
                {size === 0 ? "Enter an amount" : `Review ${verb}`}
              </button>
            </div>
          </div>
        ) : null}

        {pane === "markets" ? (
          <div className={`${styles.pane} ${styles.paneMarkets}`}>
            <h2 className={styles.paneTitle}>Markets</h2>
            <div className={styles.table}>
              {filtered.map((t) => (
                <button key={t.key} type="button" className={styles.tableRow} onClick={() => toTrade(t.key)}>
                  <TokenLogo symbol={t.key} size={30} />
                  <span>
                    <strong>{t.key}</strong>
                    <small>{t.name}</small>
                  </span>
                  <span>Spot and perps</span>
                  <span className={styles.num}>{money(t.price)}</span>
                  <span className={changeOf(t, "1d") >= 0 ? styles.up : styles.down}>{signedPercent(changeOf(t, "1d"))}</span>
                </button>
              ))}
              {filtered.length === 0 ? <p className={styles.noResult}>No market matches.</p> : null}
            </div>
            <div className={styles.accountStrip} data-testid="markets-account">
              <p className={styles.glassHead}>
                Your account
                <EyeToggle hidden={masked} onToggle={() => setMasked((m) => !m)} label="your account summary" />
              </p>
              <dl>
                {SUMMARY.map(([l, v]) => (
                  <div key={l}>
                    <dt>{l}</dt>
                    <dd>
                      <Masked hidden={masked}>{v}</Masked>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        ) : null}

        {pane === "swap" ? (
          <div className={`${styles.pane} ${styles.paneFocus}`}>
            <h2 className={styles.paneTitle}>Swap</h2>
            <div className={styles.narrow}>
              <label className={styles.field}>
                <span>You pay</span>
                <span className={styles.input}>
                  <input inputMode="decimal" value={swapText} onChange={(e) => setSwapText(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Swap amount in USDG" />
                  <TokenLogo symbol="USDG" size={22} />
                </span>
              </label>
              <p className={styles.colTitle}>You get</p>
              <TokenList tokens={filtered} active={key} onPick={pickMarket} />
              <p className={styles.swapOut} data-testid="swap-out">{`About ${money((parse(swapText) * (1 - POOL_FEE)) / token.price, 4)} ${key}`}</p>
              <Link href={"/app/swap" as Route} className="btn btn-primary btn-block">
                Swap for real
              </Link>
            </div>
          </div>
        ) : null}

        {pane === "portfolio" ? (
          <div className={`${styles.pane} ${styles.paneFocus} ${styles.paneWide}`}>
            <h2 className={styles.paneTitle}>Portfolio</h2>
            <div className={styles.placeholdersHead}>
              <p className={styles.paneLead}>Only you can see this. Example account.</p>
              <EyeToggle hidden={masked} onToggle={() => setMasked((m) => !m)} label="your portfolio" />
            </div>
            <dl className={styles.placeholders} data-testid="portfolio-values">
              {SUMMARY.map(([l, v]) => (
                <div key={l}>
                  <dt>{l}</dt>
                  <dd>
                    <Masked hidden={masked}>{v}</Masked>
                  </dd>
                </div>
              ))}
            </dl>
            <Link href={"/app/portfolio" as Route} className="btn btn-primary">
              Open your portfolio
            </Link>
          </div>
        ) : null}

        {pane === "liquidity" ? (
          <div className={`${styles.pane} ${styles.paneFocus}`}>
            <h2 className={styles.paneTitle}>Add to a pool</h2>
            <div className={styles.narrow}>
              <p className={styles.colTitle}>Pool, paired with USDG</p>
              <TokenList tokens={filtered} active={poolKey} onPick={setPoolKey} />
              <label className={styles.field}>
                <span>Amount</span>
                <span className={styles.input}>
                  <input inputMode="decimal" value={poolText} onChange={(e) => setPoolText(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Pool deposit in USDG" />
                  <TokenLogo symbol="USDG" size={22} />
                </span>
              </label>
              <p className={styles.swapOut} data-testid="pool-out">{`Half goes in as ${money(parse(poolText) / 2 / TOKEN_MAP[poolKey].price, 4)} ${poolKey}`}</p>
              <Link href={`/app/liquidity/${poolKey}` as Route} className="btn btn-primary btn-block">
                Add liquidity for real
              </Link>
            </div>
          </div>
        ) : null}

        {pane === "create" ? (
          <div className={`${styles.pane} ${styles.paneFocus}`}>
            <h2 className={styles.paneTitle}>Create a market</h2>
            <div className={styles.narrow}>
              <label className={styles.field}>
                <span>Token address</span>
                <span className={styles.input}>
                  <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x..." aria-label="Token address" spellCheck={false} />
                </span>
              </label>
              <ul className={styles.checks} role="list" data-testid="create-checks">
                <li data-ok={address.length > 3}>{address.length > 3 ? "Token found (example)" : "Paste a token to start"}</li>
                <li>The app checks the real token, price feed and backing</li>
              </ul>
              <Link href={"/app/create" as Route} className="btn btn-primary btn-block">
                Create a market for real
              </Link>
            </div>
          </div>
        ) : null}

        {review ? (
          <div className={styles.sheetWrap}>
            <div className={styles.sheet} role="dialog" aria-modal="false" aria-label="Review this example trade">
              <div className={styles.sheetHead}>
                <h3>{`Review ${verb} ${key}`}</h3>
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Close review" onClick={() => setReview(false)}>
                  <Close size={18} />
                </button>
              </div>
              <dl className={styles.rows}>
                <div>
                  <dt>{mode === "perps" ? "Size" : "You pay"}</dt>
                  <dd>{`${money(size)} USDG`}</dd>
                </div>
                {mode === "perps" ? (
                  <>
                    <div>
                      <dt>Your price</dt>
                      <dd>{money(yourPrice)}</dd>
                    </div>
                    <div>
                      <dt>Money you put up</dt>
                      <dd>{`${money(margin)} USDG`}</dd>
                    </div>
                    <div>
                      <dt>Closed out near</dt>
                      <dd>{leverage === 1 && long ? "Close to zero" : money(liq)}</dd>
                    </div>
                  </>
                ) : (
                  <div>
                    <dt>You get, about</dt>
                    <dd>{long ? `${money(received, 4)} ${key}` : `${money(size * token.price * (1 - POOL_FEE))} USDG`}</dd>
                  </div>
                )}
              </dl>
              <p className={styles.sheetNote}>Nothing happens here. This is a demo with example numbers.</p>
              <Link href={appHref} className="btn btn-primary btn-block">
                Do this for real
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
