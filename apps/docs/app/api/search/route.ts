import type { NextRequest } from "next/server";
import { getAllDocs } from "@/lib/content";
import { searchDocs } from "@/lib/search";

const LIMIT = 8;

export function GET(request: NextRequest): Response {
  const query = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 120);
  return Response.json({ query, results: searchDocs(getAllDocs(), query, LIMIT) }, { headers: { "Cache-Control": "public, max-age=300" } });
}
