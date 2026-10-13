import { mockAttestation } from "@/lib/mock-server";
export const dynamic = "force-dynamic";
export async function GET(req: Request) { return mockAttestation(req); }
