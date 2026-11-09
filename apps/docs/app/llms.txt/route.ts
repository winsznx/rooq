import { DOC_SECTIONS, docPath } from "@/lib/manifest";
import { DOCS_URL } from "@/lib/site";

export const dynamic = "force-static";

export function GET(): Response {
  const sections = DOC_SECTIONS.map(
    (section) => `## ${section.title}\n\n${section.pages.map((page) => `- [${page.title}](${DOCS_URL}/${page.slug}.md): ${page.description}`).join("\n")}`,
  );
  const body = `# Rooq Docs\n\n> Private spot and matched-pair perps for stock tokens on Robinhood Chain testnet. Testnet only: test tokens have no value and Rooq has not been audited.\n\n${sections.join("\n\n")}\n\nDocs home: ${DOCS_URL}${docPath("introduction")}\n`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
