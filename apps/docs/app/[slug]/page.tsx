import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle } from "@/components/doc-article";
import { getDoc } from "@/lib/content";
import { DOC_PAGES, INTRODUCTION_SLUG } from "@/lib/manifest";
import { APP_URL, DOCS_URL } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return DOC_PAGES.filter((page) => page.slug !== INTRODUCTION_SLUG).map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: PageProps<"/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const page = DOC_PAGES.find((entry) => entry.slug === slug);
  if (!page) return {};
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: page.path, types: { "text/markdown": `/${page.slug}.md` } },
    openGraph: { type: "article", title: page.title, description: page.description, url: page.path },
  };
}

export default async function DocRoute({ params }: PageProps<"/[slug]">) {
  const { slug } = await params;
  const doc = slug === INTRODUCTION_SLUG ? undefined : getDoc(slug);
  if (!doc) notFound();
  const jsonLd = { "@context": "https://schema.org", "@type": "TechArticle", headline: doc.title, description: doc.description, url: doc.url, isPartOf: { "@type": "WebSite", name: "Rooq Docs", url: DOCS_URL }, about: { "@type": "WebApplication", name: "Rooq", url: APP_URL } };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <DocArticle doc={doc} />
    </>
  );
}
