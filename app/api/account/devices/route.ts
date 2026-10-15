import { listDevices, removeDevice } from "@/lib/account-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = listDevices;
export const DELETE = removeDevice;
