import { docAsMarkdown, getDoc } from "@/lib/content";
import { DOC_PAGES } from "@/lib/manifest";

export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return DOC_PAGES.map((page) => ({ slug: page.slug }));
}

export async function GET(_request: Request, { params }: RouteContext<"/md/[slug]">): Promise<Response> {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) return new Response("Not found", { status: 404 });
  return new Response(docAsMarkdown(doc), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
