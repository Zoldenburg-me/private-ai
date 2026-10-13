import { loadProviders } from "@/lib/providers";
export async function GET() {
  return Response.json(loadProviders().map(({ id, name, privacy, defaultModel }) => ({ id, name, privacy, defaultModel })));
}
