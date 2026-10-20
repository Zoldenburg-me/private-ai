import { clearEntitlement, setEntitlement } from "@/lib/admin-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = setEntitlement;
export const DELETE = clearEntitlement;
