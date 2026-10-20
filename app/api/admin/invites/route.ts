import { addInvite, listInvites, revokeInvite } from "@/lib/admin-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = listInvites;
export const POST = addInvite;
export const DELETE = revokeInvite;
