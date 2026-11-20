import { MarketsView } from "@/components/admin/markets-view";
import { adminPageMetadata, requireAdmin } from "@/lib/admin/session";

export const generateMetadata = adminPageMetadata("Markets");

export default async function AdminMarketsPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  return <MarketsView />;
}
