import { ActivityView } from "@/components/admin/activity-view";
import { adminPageMetadata, requireAdmin } from "@/lib/admin/session";

export const generateMetadata = adminPageMetadata("Activity");

export default async function AdminActivityPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  return <ActivityView />;
}
