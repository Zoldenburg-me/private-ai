import { handleChat } from "@/lib/handler";
import { getCatalog } from "@/lib/catalog-cache";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** OpenAI-compatible. Auth: Bearer <apiToken from /api/session>. Extension: `pai_options`. */
export async function POST(req: Request) { return handleChat(req, "/api/v1/chat/completions", { catalog: getCatalog }); }
