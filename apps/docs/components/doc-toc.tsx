"use client";

import { useEffect, useState } from "react";
import type { DocHeading } from "@/lib/markdown";
import styles from "./docs.module.css";

/** Distance below the sticky header where a heading counts as the one being read. */
const READING_LINE = 120;

export function DocToc({ headings }: { headings: readonly DocHeading[] }) {
  const [active, setActive] = useState(headings[0]?.id ?? "");

  useEffect(() => {
    const elements = headings.map((h) => document.getElementById(h.id)).filter((el): el is HTMLElement => el !== null);
    let frame = 0;
    const update = () => {
      frame = 0;
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      const passed = elements.filter((el) => el.getBoundingClientRect().top <= READING_LINE);
      const current = atBottom ? elements[elements.length - 1] : passed[passed.length - 1];
      setActive(current?.id ?? elements[0]?.id ?? "");
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
  }, [headings]);

  return (
    <aside aria-label="On this page" className={styles.toc}>
      <p>On this page</p>
      <ul>
        {headings.map((h) => (
          <li className={h.depth === 3 ? styles.tocDeep : undefined} key={h.id}>
            <a aria-current={h.id === active ? "location" : undefined} href={`#${h.id}`}>
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
