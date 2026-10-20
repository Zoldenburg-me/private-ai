import { addKey, listKeys, removeKey, setKeyStatus } from "@/lib/admin-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = listKeys;
export const POST = addKey;
export const PATCH = setKeyStatus;
export const DELETE = removeKey;
