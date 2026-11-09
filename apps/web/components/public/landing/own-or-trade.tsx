"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { EyeToggle, Masked } from "./masked";
import { TokenLogo } from "./token-logo";
import { TOKENS, TOKEN_MAP, money, type DemoToken } from "./data";
import styles from "./landing.module.css";

const STAKE = 1000;
const LEV = 2;
const MAINTENANCE = 0.35;

/** Side-by-side outcome of the same price move. Plain arithmetic on an example amount, before fees and funding. */
export function OwnOrTrade() {
  const [key, setKey] = useState<DemoToken["key"]>("NFLX");
  const [move, setMove] = useState(12);
  const [hideSpot, setHideSpot] = useState(false);
  const [hidePerp, setHidePerp] = useState(false);
  const token = TOKEN_MAP[key];
  const newPrice = token.price * (1 + move / 100);
  const units = STAKE / token.price;
  const spotValue = units * newPrice;
  const liqMove = ((1 - 1 / LEV) / (1 - MAINTENANCE) - 1) * 100;
  const closed = move <= liqMove;
  const perpValue = closed ? 0 : STAKE * (1 + (LEV * move) / 100);
  const fmtDelta = (v: number) => `${v - STAKE >= 0 ? "+" : "-"}$${money(Math.abs(v - STAKE))}`;
  return (
    <section className={styles.white} aria-labelledby="own">
      <div className={styles.inner}>
        <div className={styles.ownHead}>
          <h2 id="own" className={styles.h2}>
            Own it, or trade it
          </h2>
          <p className={styles.lead}>Two private ways into the same stock token. Move the slider and compare $1,000 each way.</p>
        </div>

        <div className={styles.pickRow} role="group" aria-label="Pick a token">
          {TOKENS.map((t) => (
            <button key={t.key} type="button" aria-pressed={key === t.key} onClick={() => setKey(t.key)}>
              <TokenLogo symbol={t.key} size={26} />
              {t.key}
            </button>
          ))}
        </div>

        <label className={styles.slider}>
          <span className={styles.sliderHead}>
            <span>If the price moves</span>
            <output data-testid="move" className={move >= 0 ? styles.up : styles.down}>{`${move >= 0 ? "+" : ""}${move}%`}</output>
            <span className={styles.sliderPrice}>{`${key} ${money(token.price)} to ${money(newPrice)}`}</span>
          </span>
          <input type="range" min={-40} max={40} step={1} value={move} onChange={(e) => setMove(Number(e.target.value))} aria-label="Price move in percent" />
        </label>

        <div className={styles.compare}>
          <article className={styles.compareCard}>
            <h3 className={styles.cardHead}>
              Buy the token
              <EyeToggle hidden={hideSpot} onToggle={() => setHideSpot((h) => !h)} label="this balance" />
            </h3>
            <p className={styles.compareValue} data-testid="spot-value">
              <Masked hidden={hideSpot}>{`$${money(spotValue)}`}</Masked>
            </p>
            <p className={move >= 0 ? styles.up : styles.down}>{fmtDelta(spotValue)}</p>
            <ul role="list">
              <li>{`You own ${money(units, 3)} ${key}, in your private balance`}</li>
              <li>You can never be closed out</li>
            </ul>
            <Link href={`/app/trade/${key}?mode=spot` as Route} className="btn">
              {`Buy ${key}`}
            </Link>
          </article>
          <article className={styles.compareCard} data-closed={closed}>
            <h3 className={styles.cardHead}>
              {`Trade its price at ${LEV}x`}
              <EyeToggle hidden={hidePerp} onToggle={() => setHidePerp((h) => !h)} label="this position" />
            </h3>
            <p className={styles.compareValue} data-testid="perp-value">
              <Masked hidden={hidePerp}>{closed ? "$0.00" : `$${money(perpValue)}`}</Masked>
            </p>
            <p className={perpValue >= STAKE ? styles.up : styles.down}>{closed ? "Closed out. Your $1,000 is gone" : fmtDelta(perpValue)}</p>
            <ul role="list">
              <li>{`A private position, not the ${key} token`}</li>
              <li>{`Closed out if the price falls about ${Math.abs(liqMove).toFixed(0)}%`}</li>
            </ul>
            <Link href={`/app/trade/${key}?mode=perps` as Route} className="btn">
              {`Trade ${key}`}
            </Link>
          </article>
        </div>
        <p className={styles.small}>Example maths on an example amount, before fees and funding. Assumes long at 2x with 35% maintenance margin.</p>
      </div>
    </section>
  );
}
