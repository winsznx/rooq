import type { Metadata } from "next";
import { TradeView } from "@/components/trade/trade-view";

export async function generateMetadata(props: PageProps<"/app/trade/[marketId]">): Promise<Metadata> {
  const { marketId } = await props.params;
  return { title: `Trade ${marketId}` };
}

export default async function TradePage(props: PageProps<"/app/trade/[marketId]">) {
  const { marketId } = await props.params;
  const search = await props.searchParams;
  const mode = search.mode === "spot" ? "spot" : "perps";
  return <TradeView marketKey={decodeURIComponent(marketId)} mode={mode} />;
}
