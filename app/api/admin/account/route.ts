import { deleteAccount, getAccount } from "@/lib/admin-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = getAccount;
export const DELETE = deleteAccount;
