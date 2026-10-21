import { mockSearch } from "@/lib/mock-server";
export const dynamic = "force-dynamic";
export async function GET() { return mockSearch(); }
