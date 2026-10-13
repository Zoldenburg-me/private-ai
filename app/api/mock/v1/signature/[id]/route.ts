import { mockSignature } from "@/lib/mock-server";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) { return mockSignature((await ctx.params).id); }
