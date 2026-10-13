import { mockChat } from "@/lib/mock-server";
export const dynamic = "force-dynamic";
export async function POST(req: Request) { return mockChat(req); }
