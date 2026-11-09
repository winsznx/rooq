import Image from "next/image";
import { logoPlate } from "@rooq/config";
import { LOGOS } from "./data";
import styles from "./landing.module.css";

export function TokenLogo({ symbol, size = 24 }: { symbol: string; size?: number }) {
  const src = LOGOS[symbol]!;
  const mark = Math.round(size * 0.62);
  return (
    <span className={styles.logo} style={{ width: size, height: size, background: logoPlate(src) ?? "#fff" }}>
      <Image src={src} alt="" width={mark} height={mark} />
    </span>
  );
}
