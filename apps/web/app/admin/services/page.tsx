import { ServicesView } from "@/components/admin/services-view";
import { adminPageMetadata, requireAdmin } from "@/lib/admin/session";

export const generateMetadata = adminPageMetadata("Services");

export default async function AdminServicesPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  return <ServicesView />;
}
