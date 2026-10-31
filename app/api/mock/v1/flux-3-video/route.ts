import { mockVideo } from "@/lib/mock-server";
export const dynamic = "force-dynamic";
export async function POST(req: Request) { return mockVideo(req); }
export async function GET(req: Request) { return mockVideo(req); }
