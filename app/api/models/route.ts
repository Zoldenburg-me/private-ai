import { getCatalog } from "@/lib/catalog-cache";
import { withStores } from "@/lib/store";
export const dynamic = "force-dynamic";
// Provider keys may live in Postgres: an outage gives 503, like every other store-backed route.
export const GET = withStores(async () => Response.json(await getCatalog(), { headers: { "Cache-Control": "no-store" } }));
