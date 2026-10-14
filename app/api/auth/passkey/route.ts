import { listPasskeys, removePasskey } from "@/lib/passkey-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = listPasskeys;
export const DELETE = removePasskey;
