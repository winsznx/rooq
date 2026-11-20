import { MoneyView } from "@/components/admin/money-view";
import { adminPageMetadata, requireAdmin } from "@/lib/admin/session";

export const generateMetadata = adminPageMetadata("Money");

export default async function AdminMoneyPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  return <MoneyView />;
}
