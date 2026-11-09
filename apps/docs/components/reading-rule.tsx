"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import styles from "./docs.module.css";

/** The datum rule under the header. Its filled length is how far down the page you have read. */
export function ReadingRule() {
  const fill = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, window.scrollY / max) : 0;
      if (fill.current) fill.current.style.transform = `scaleX(${ratio})`;
    };
    const onChange = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onChange, { passive: true });
    window.addEventListener("resize", onChange);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, [pathname]);

  return (
    <div aria-hidden="true" className={styles.datum}>
      <div className={styles.datumFill} ref={fill} />
    </div>
  );
}
