import { OperatorsView } from "@/components/admin/operators-view";
import { adminPageMetadata, requireAdmin } from "@/lib/admin/session";

export const generateMetadata = adminPageMetadata("Operators");

export default async function AdminOperatorsPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  return <OperatorsView />;
}
