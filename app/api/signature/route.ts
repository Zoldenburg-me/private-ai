import { proxyEvidence } from "@/lib/evidence";
export const dynamic = "force-dynamic";
export async function GET(req: Request) { return proxyEvidence("signature", new URL(req.url)); }
