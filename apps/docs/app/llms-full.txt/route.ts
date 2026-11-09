import { docAsMarkdown, getAllDocs } from "@/lib/content";

export const dynamic = "force-static";

export function GET(): Response {
  const body = getAllDocs().map(docAsMarkdown).join("\n---\n\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
