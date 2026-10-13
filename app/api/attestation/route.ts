import { proxyEvidence } from "@/lib/evidence";
export const dynamic = "force-dynamic";
export async function GET(req: Request) { return proxyEvidence("attestation", new URL(req.url)); }
