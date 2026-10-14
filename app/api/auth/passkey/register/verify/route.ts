import { registerVerify } from "@/lib/passkey-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = registerVerify;
