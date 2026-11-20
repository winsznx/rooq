import { WalletsView } from "@/components/admin/wallets-view";
import { adminPageMetadata, requireAdmin } from "@/lib/admin/session";

export const generateMetadata = adminPageMetadata("Wallets");

export default async function AdminWalletsPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  return <WalletsView />;
}
