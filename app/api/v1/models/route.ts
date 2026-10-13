import { getCatalog } from "@/lib/catalog-cache";
export const dynamic = "force-dynamic";
/** OpenAI-compatible model list (selectable models only) plus our privacy fields. */
export async function GET() {
  const data = (await getCatalog()).filter((m) => m.selectable).map((m) => ({
    id: `${m.provider}:${m.id}`, object: "model", owned_by: m.provider,
    pai_privacy: { level: m.privacy, tee: m.tee, e2ee: m.e2ee }, context_length: m.contextLength,
  }));
  return Response.json({ object: "list", data });
}
