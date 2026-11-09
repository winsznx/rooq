"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { SearchResult } from "@/lib/search";
import styles from "./docs.module.css";

type SearchState = { status: "idle" } | { status: "done"; query: string; results: readonly SearchResult[] } | { status: "error"; query: string };

const DEBOUNCE_MS = 140;

export function DocsSearch({ autoFocus = false, shortcut = true, onNavigate }: { autoFocus?: boolean; shortcut?: boolean; onNavigate?: () => void }) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef<AbortController>(undefined);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [state, setState] = useState<SearchState>({ status: "idle" });

  useEffect(() => {
    if (!shortcut) return;
    const focusOnSlash = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", focusOnSlash);
    return () => window.removeEventListener("keydown", focusOnSlash);
  }, [shortcut]);

  const runSearch = (value: string) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    fetch(`/api/search?q=${encodeURIComponent(value)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Search failed with ${response.status}`);
        return response.json() as Promise<{ results: SearchResult[] }>;
      })
      .then((body) => {
        setState({ status: "done", query: value, results: body.results });
        setActive(0);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ status: "error", query: value });
      });
  };

  const onChange = (value: string) => {
    setQuery(value);
    setOpen(true);
    clearTimeout(timer.current);
    if (value.trim().length < 2) {
      inFlight.current?.abort();
      setState({ status: "idle" });
      return;
    }
    timer.current = setTimeout(() => runSearch(value.trim()), DEBOUNCE_MS);
  };

  const results = state.status === "done" ? state.results : [];
  const showPanel = open && state.status !== "idle";

  const go = (result: SearchResult) => {
    setOpen(false);
    onNavigate?.();
    router.push(result.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!showPanel || results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = results[active];
      if (chosen) go(chosen);
    }
  };

  return (
    <div className={styles.search} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
        <path d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm9.5 2.5-4.2-4.2" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
      <input
        aria-activedescendant={showPanel && results[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={showPanel}
        aria-label="Search the docs"
        autoComplete="off"
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search the docs"
        ref={inputRef}
        role="combobox"
        spellCheck={false}
        type="search"
        value={query}
      />
      {shortcut ? <kbd aria-hidden="true">/</kbd> : null}
      {showPanel ? (
        <div className={styles.searchPanel} id={listId} role="listbox">
          {state.status === "error" ? <p>Search isn&apos;t answering. Try again.</p> : null}
          {state.status === "done" && results.length === 0 ? <p>{`Nothing matches "${state.query}".`}</p> : null}
          {results.map((result, i) => (
            <Link
              aria-selected={i === active}
              data-active={i === active}
              href={result.path}
              id={`${listId}-${i}`}
              key={result.id}
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              onMouseEnter={() => setActive(i)}
              role="option"
            >
              <strong>{result.heading}</strong>
              <span className={styles.searchPage}>{result.page}</span>
              <span className={styles.searchSnippet}>{result.snippet}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
