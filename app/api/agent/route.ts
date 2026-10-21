import { handleAgent } from "@/lib/handler";
import { getCatalog } from "@/lib/catalog-cache";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Privacy: no content logging. Only lib/log.ts metaLogger (metadata) is allowed here.
export async function POST(req: Request) { return handleAgent(req, "/api/agent", { catalog: getCatalog }); }
