import { readFileSync } from "node:fs";
import path from "node:path";
import { DOC_PAGES, type IndexedDocPage } from "./manifest";
import { parseChunks, parseDoc, type DocChunk, type DocHeading } from "./markdown";
import { APP_URL, DOCS_URL, SUPPORT_EMAIL } from "./site";
import { visibilityMarkdown } from "./visibility";

export interface Doc extends IndexedDocPage {
  readonly html: string;
  readonly headings: readonly DocHeading[];
  readonly chunks: readonly DocChunk[];
  /** Plain markdown with every slot expanded, for search, llms.txt and the .md routes. */
  readonly markdown: string;
}

const CONTENT_DIR = path.join(process.cwd(), "content");
const VALUES: Readonly<Record<string, string>> = { app_url: APP_URL, docs_url: DOCS_URL, support_email: SUPPORT_EMAIL };
const SLOT_TEXT: Readonly<Record<string, () => string>> = {
  lens: visibilityMarkdown,
  "contracts-table": () => "The address of every contract is in the table on this page.",
};

function load(page: IndexedDocPage): Doc {
  const source = readFileSync(path.join(CONTENT_DIR, `${page.slug}.md`), "utf8").replace(/\{\{(\w+)\}\}/g, (match, key: string) => VALUES[key] ?? match);
  const markdown = source.replace(/```slot:([\w-]+)\n```/g, (_, name: string) => SLOT_TEXT[name]?.() ?? "");
  const { html, headings } = parseDoc(source);
  return { ...page, html, headings, markdown, chunks: parseChunks(markdown, page.title) };
}

/** Parsed once per process in production. Reparsed on every call in `next dev` so edits show up. */
const cache = new Map<string, Doc>();

export function getDoc(slug: string): Doc | undefined {
  const page = DOC_PAGES.find((entry) => entry.slug === slug);
  if (!page) return undefined;
  if (process.env.NODE_ENV !== "production") return load(page);
  let doc = cache.get(slug);
  if (!doc) {
    doc = load(page);
    cache.set(slug, doc);
  }
  return doc;
}

export function getAllDocs(): Doc[] {
  return DOC_PAGES.map((page) => getDoc(page.slug)).filter((doc): doc is Doc => doc !== undefined);
}

export function docAsMarkdown(doc: Doc): string {
  return `# ${doc.title}\n\n> ${doc.description}\n\nSource: ${doc.url}\n\n${doc.markdown.replace(/\]\(\//g, `](${DOCS_URL}/`).trim()}\n`;
}
