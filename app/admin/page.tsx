import { AdminPanel } from "@/components/admin/AdminPanel";
import { AUDIT_LOG_DAYS } from "@/lib/store/types";

export default function AdminPage() {
  return <AdminPanel auditDays={AUDIT_LOG_DAYS} />;
}
