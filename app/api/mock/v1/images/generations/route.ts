import { mockImage } from "@/lib/mock-server";
export const dynamic = "force-dynamic";
export async function POST() { return mockImage(); }
