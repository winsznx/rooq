import type { MetadataRoute } from "next";
import { DOC_PAGES } from "@/lib/manifest";

export default function sitemap(): MetadataRoute.Sitemap {
  return DOC_PAGES.map((page) => ({ url: page.url }));
}
