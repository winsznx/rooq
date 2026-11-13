"use client";

import Image from "next/image";
import { useState } from "react";
import { Check, Copy, External } from "../../icons";
import styles from "./landing.module.css";

const ROOQ_CA = "0x56f316047b358c0d3c04540ff47ff4373df48ec0";
const PONS_URL = `https://ponsfamily.com/launchpad/${ROOQ_CA}`;
const SHORT_CA = `${ROOQ_CA.slice(0, 6)}…${ROOQ_CA.slice(-4)}`;

export function TokenCa() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ROOQ_CA);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      console.warn("rooq: contract address not copied", error);
    }
  };
  return (
    <div className={styles.ca}>
      <button type="button" className={styles.caCopy} onClick={() => void copy()} aria-label={`Copy ROOQ contract address ${ROOQ_CA}`}>
        <span className={styles.caLabel}>CA</span>
        <span className={styles.caValue}>{SHORT_CA}</span>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <a href={PONS_URL} className={styles.caBuy} target="_blank" rel="noreferrer">
        <Image src="/logos/pons.png" alt="" width={18} height={18} className={styles.caLogo} />
        Buy ROOQ on Pons
        <External size={14} />
      </a>
      <span className={styles.caStatus} role="status" aria-live="polite">{copied ? "Copied" : ""}</span>
    </div>
  );
}
