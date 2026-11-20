import { TrafficView } from "@/components/admin/traffic-view";
import { adminPageMetadata, requireAdmin } from "@/lib/admin/session";

export const generateMetadata = adminPageMetadata("Traffic");

export default async function AdminTrafficPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  return <TrafficView />;
}
