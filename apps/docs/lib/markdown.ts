import { Marked, Renderer, type Token, type Tokens, walkTokens } from "marked";

export interface DocHeading {
  readonly id: string;
  readonly text: string;
  readonly depth: number;
}

/** The text under one heading up to the next. Search ranks these. */
export interface DocChunk {
  readonly id: string;
  readonly heading: string;
  readonly text: string;
}

export interface ParsedDoc {
  readonly html: string;
  readonly headings: readonly DocHeading[];
}

/** Stands in for a React slot in rendered HTML. See `slotParts`. */
const SLOT_OPEN = "<!--slot:";
const SLOT_CLOSE = "-->";

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseDoc(markdown: string): ParsedDoc {
  const tokens = new Marked({ gfm: true }).lexer(markdown);
  const ids = headingIds(tokens);
  return { html: renderer(ids).parser(tokens), headings: tokens.filter(isSectionHeading).map((h) => ({ id: ids.get(h) ?? "", text: inlineText(h.tokens), depth: h.depth })) };
}

export function parseChunks(markdown: string, title: string): DocChunk[] {
  const tokens = new Marked({ gfm: true }).lexer(markdown);
  const ids = headingIds(tokens);
  let current = { id: "", heading: title, tokens: [] as Token[] };
  const chunks = [current];
  for (const token of tokens) {
    if (isSectionHeading(token)) {
      current = { id: ids.get(token) ?? "", heading: inlineText(token.tokens), tokens: [] };
      chunks.push(current);
    } else {
      current.tokens.push(token);
    }
  }
  return chunks.map((c) => ({ id: c.id, heading: c.heading, text: c.tokens.map(blockText).join("\n").trim() })).filter((c) => c.text.length > 0);
}

/** Splits rendered HTML around slot markers so a React component can sit between two pieces of article. */
export function slotParts(html: string): readonly ({ kind: "html"; html: string } | { kind: "slot"; name: string })[] {
  const parts: ({ kind: "html"; html: string } | { kind: "slot"; name: string })[] = [];
  let rest = html;
  for (;;) {
    const open = rest.indexOf(SLOT_OPEN);
    if (open === -1) break;
    const close = rest.indexOf(SLOT_CLOSE, open);
    parts.push({ kind: "html", html: rest.slice(0, open) }, { kind: "slot", name: rest.slice(open + SLOT_OPEN.length, close).trim() });
    rest = rest.slice(close + SLOT_CLOSE.length);
  }
  parts.push({ kind: "html", html: rest });
  return parts;
}

function isSectionHeading(token: Token): token is Tokens.Heading {
  return token.type === "heading" && ((token as Tokens.Heading).depth === 2 || (token as Tokens.Heading).depth === 3);
}

function headingIds(tokens: Token[]): WeakMap<Token, string> {
  const ids = new WeakMap<Token, string>();
  const used = new Map<string, number>();
  walkTokens(tokens, (token) => {
    if (token.type !== "heading") return;
    const base = slugifyHeading(inlineText((token as Tokens.Heading).tokens)) || "section";
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    ids.set(token, seen === 0 ? base : `${base}-${seen}`);
  });
  return ids;
}

function renderer(ids: WeakMap<Token, string>): Marked {
  const base = new Renderer();
  return new Marked({
    gfm: true,
    renderer: {
      heading(token) {
        const id = ids.get(token);
        const inner = this.parser.parseInline(token.tokens);
        if (!id || token.depth === 1) return `<h${token.depth}>${inner}</h${token.depth}>\n`;
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${token.depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        if (/^\s*(javascript|data|vbscript):/i.test(href)) return text;
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
        const external = /^https?:\/\//i.test(href);
        return `<a href="${escapeHtml(href)}"${titleAttribute}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
      },
      table(token) {
        return `<div class="doc-table">${base.table.call(this, token)}</div>\n`;
      },
      blockquote({ tokens }) {
        return `<aside class="doc-note">${this.parser.parse(tokens)}</aside>\n`;
      },
      html({ text }) {
        return escapeHtml(text);
      },
      code({ text, lang }) {
        if (lang === "who-sees") return whoSees(text);
        if (lang?.startsWith("slot:")) return `${SLOT_OPEN}${lang.slice(5)}${SLOT_CLOSE}`;
        return `<pre class="doc-code"><code>${escapeHtml(text)}</code></pre>\n`;
      },
    },
  });
}

/** Each line is `who | what they can see`. A leading `-` on the right marks a party that sees nothing extra. */
function whoSees(source: string): string {
  const rows = source
    .split("\n")
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== "" && parts[1] !== "")
    .map(([who, what]) => {
      const hidden = what.startsWith("- ");
      return `<div data-seen="${hidden ? "no" : "yes"}"><dt>${escapeHtml(who)}</dt><dd>${escapeHtml(hidden ? what.slice(2) : what)}</dd></div>`;
    });
  return `<figure class="who-sees"><figcaption>Who can see this</figcaption><dl>${rows.join("")}</dl></figure>\n`;
}

function inlineText(tokens: readonly Token[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((token) => {
      if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens);
      if (token.type === "html") return "";
      return "text" in token && typeof token.text === "string" ? token.text : "";
    })
    .join("");
}

function blockText(token: Token): string {
  switch (token.type) {
    case "paragraph":
    case "heading":
      return inlineText((token as Tokens.Paragraph).tokens);
    case "list":
      return (token as Tokens.List).items.map((item) => (item.tokens ?? []).map(blockText).join(" ")).join("\n");
    case "text":
      return inlineText((token as Tokens.Text).tokens) || (token as Tokens.Text).text;
    case "blockquote":
      return ((token as Tokens.Blockquote).tokens ?? []).map(blockText).join(" ");
    case "code":
      return (token as Tokens.Code).text;
    case "table": {
      const table = token as Tokens.Table;
      return [table.header, ...table.rows].map((row) => row.map((cell) => inlineText(cell.tokens)).join(" ")).join("\n");
    }
    default:
      return "";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
