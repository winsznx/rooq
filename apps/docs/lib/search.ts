import type { Doc } from "./content";
import { docPath } from "./manifest";

export interface SearchResult {
  readonly id: string;
  readonly page: string;
  readonly heading: string;
  readonly path: string;
  readonly snippet: string;
}

const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from", "how", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "the", "to", "what", "when", "who", "why", "with", "you", "your"]);
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 130;

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function matchWeight(word: string, term: string): number {
  if (word === term) return 1;
  const [shorter, longer] = word.length < term.length ? [word, term] : [term, word];
  if (shorter.length >= 3 && longer.startsWith(shorter) && ["s", "es", "d", "ed", "ing"].includes(longer.slice(shorter.length))) return 0.8;
  return term.length >= 4 && word.startsWith(term) ? 0.6 : 0;
}

function scoreChunk(title: string, heading: string, body: string, terms: readonly string[], phrase: string): number {
  const titleWords = words(`${title} ${heading}`);
  const bodyWords = words(body);
  let score = 0;
  let found = 0;
  for (const term of terms) {
    const inTitle = Math.max(0, ...titleWords.map((word) => matchWeight(word, term)));
    const inBody = bodyWords.reduce((sum, word) => sum + matchWeight(word, term), 0);
    if (inTitle > 0 || inBody > 0) found += 1;
    score += inTitle * 8 + Math.log2(1 + inBody) * 2;
  }
  if (found === 0) return 0;
  const coverage = found / terms.length;
  const phraseBonus = terms.length > 1 && body.toLowerCase().includes(phrase) ? 6 : 0;
  return (score + phraseBonus) * coverage * coverage;
}

function snippetOf(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const hits = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const center = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, center - SNIPPET_BEFORE);
  const end = Math.min(flat.length, center + SNIPPET_AFTER);
  const from = start === 0 ? 0 : flat.indexOf(" ", start) + 1;
  const to = end === flat.length ? end : Math.max(flat.lastIndexOf(" ", end), from);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to).trim()}${to < flat.length ? "…" : ""}`;
}

export function searchDocs(docs: readonly Doc[], query: string, limit: number): SearchResult[] {
  const all = words(query);
  const terms = all.filter((word) => !STOP_WORDS.has(word));
  const used = terms.length > 0 ? terms : all;
  if (used.length === 0) return [];
  const phrase = used.join(" ");
  const scored = docs.flatMap((doc) =>
    doc.chunks.map((chunk) => ({ doc, chunk, score: scoreChunk(doc.title, chunk.heading, chunk.text, used, phrase) })).filter((row) => row.score > 0),
  );
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, chunk }) => ({
      id: `${doc.slug}#${chunk.id}`,
      page: doc.title,
      heading: chunk.id === "" ? doc.title : chunk.heading,
      path: `${docPath(doc.slug)}${chunk.id === "" ? "" : `#${chunk.id}`}`,
      snippet: snippetOf(chunk.text, used),
    }));
}
