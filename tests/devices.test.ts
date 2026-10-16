import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setStores, type Stores } from "../lib/store";
import { purgeInactive, RETENTION_DAYS } from "../lib/retention";
import { createSession, verifyToken } from "../lib/session";
import { handleChat } from "../lib/handler";
import { GET as sessionGET } from "../app/api/session/route";
import { POST as regOptions } from "../app/api/auth/passkey/register/options/route";
import { POST as regVerify } from "../app/api/auth/passkey/register/verify/route";
import { POST as loginOptions } from "../app/api/auth/passkey/login/options/route";
import { POST as loginVerify } from "../app/api/auth/passkey/login/verify/route";
import { GET as listPasskeys } from "../app/api/auth/passkey/route";
import { POST as signout } from "../app/api/auth/signout/route";
import { GET as listDevices, DELETE as removeDevice } from "../app/api/account/devices/route";
import { GET as exportGET } from "../app/api/account/export/route";
import { SoftAuthenticator } from "./helpers/soft-authenticator";

const ORIGIN = "http://localhost:3000";
const req = (path: string, method: string, token?: string, body?: unknown) => new Request(`${ORIGIN}${path}`, {
  method, headers: { "Content-Type": "application/json", ...(token ? { Cookie: `pai_session=${encodeURIComponent(token)}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const cookieToken = (r: Response) => {
  const m = /^pai_session=([^;]*)/.exec(r.headers.get("set-cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : null;
};

/** Anonymous visitor saves their account with a passkey; returns the device token they now hold. */
async function createAccount(auth: SoftAuthenticator) {
  const { id, token } = await createSession();
  const opts = await (await regOptions(req("/r", "POST", token, {}))).json();
  const r = await regVerify(req("/r", "POST", token, auth.create(opts, ORIGIN)));
  expect(r.status).toBe(200);
  const body = await r.json();
  const device = cookieToken(r)!;
  expect(body.apiToken).toBe(device);
  return { id, legacy: token, device };
}
async function signIn(auth: SoftAuthenticator, current?: string) {
  const opts = await (await loginOptions(req("/l", "POST", current, {}))).json();
  const r = await loginVerify(req("/l", "POST", current, auth.get(opts, ORIGIN)));
  expect(r.status).toBe(200);
  return cookieToken(r)!;
}
async function stepUp(auth: SoftAuthenticator, token: string) {
  const opts = await (await loginOptions(req("/l", "POST", token, { stepUp: true }))).json();
  return loginVerify(req("/l", "POST", token, auth.get(opts, ORIGIN)));
}
const devices = async (token: string) => (await (await listDevices(req("/d", "GET", token))).json()).devices as { id: string; createdAt: number; lastSeenOn: string; current: boolean }[];

let st: Stores;
beforeEach(() => { st = _setStores(); });

describe("creating an account", () => {
  it("first passkey turns the anonymous session into a signed-in device; the old token stops working", async () => {
    const auth = new SoftAuthenticator();
    const { id, legacy, device } = await createAccount(auth);
    expect(verifyToken(device)).toBe(id);
    expect(device).not.toBe(legacy);
    expect((await listPasskeys(req("/p", "GET", legacy))).status).toBe(401);
    expect((await listPasskeys(req("/p", "GET", device))).status).toBe(200);
    const s = await (await sessionGET(req("/api/session", "GET", device))).json();
    expect(s.account).toEqual({ signedIn: true, id: id.slice(0, 6) });
    expect(await devices(device)).toEqual([expect.objectContaining({ current: true })]);
  });
  it("adding a second passkey keeps the same device token", async () => {
    const auth = new SoftAuthenticator();
    const { device } = await createAccount(auth);
    expect((await stepUp(auth, device)).status).toBe(200);
    const opts = await (await regOptions(req("/r", "POST", device, {}))).json();
    const r = await regVerify(req("/r", "POST", device, new SoftAuthenticator().create(opts, ORIGIN)));
    expect(await r.json()).toEqual({ registered: true });
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await devices(device)).toHaveLength(1);
  });
  it("an anonymous session reports signedIn: false", async () => {
    const { id, token } = await createSession();
    const s = await (await sessionGET(req("/api/session", "GET", token))).json();
    expect(s.account).toEqual({ signedIn: false, id: id.slice(0, 6) });
  });
});

describe("signing in on another device", () => {
  it("adds a device on the same account; step-up adds none and sets no cookie", async () => {
    const auth = new SoftAuthenticator();
    const { id, device: a } = await createAccount(auth);
    const b = await signIn(auth);
    expect(verifyToken(b)).toBe(id);
    expect(b).not.toBe(a);
    const list = await devices(b);
    expect(list).toHaveLength(2);
    expect(list.filter((d) => d.current)).toHaveLength(1);
    const su = await stepUp(auth, a);
    expect(su.status).toBe(200);
    expect(su.headers.get("set-cookie")).toBeNull();
    expect(await devices(a)).toHaveLength(2);
  });
  it("signing in again on the same browser replaces its device instead of piling up", async () => {
    const auth = new SoftAuthenticator();
    const { device } = await createAccount(auth);
    const again = await signIn(auth, device);
    expect(await devices(again)).toHaveLength(1);
    expect((await listDevices(req("/d", "GET", device))).status).toBe(401);
  });
});

describe("POST /api/auth/signout", () => {
  it("revokes this device only and clears the cookie", async () => {
    const auth = new SoftAuthenticator();
    const { device: a } = await createAccount(auth);
    const b = await signIn(auth);
    const r = await signout(req("/s", "POST", b));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/^pai_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
    expect((await listDevices(req("/d", "GET", b))).status).toBe(401);
    expect(await devices(a)).toHaveLength(1);
    // the revoked browser gets a fresh anonymous session, not the account
    const s = await sessionGET(req("/api/session", "GET", b));
    expect((await s.json()).account.signedIn).toBe(false);
    expect(cookieToken(s)).not.toBe(b);
  });
  it("revoked tokens are refused by the chat API", async () => {
    const auth = new SoftAuthenticator();
    const { device } = await createAccount(auth);
    await signout(req("/s", "POST", device));
    const r = await handleChat(new Request("http://app/x", { method: "POST", headers: { Authorization: `Bearer ${device}` }, body: "{}" }), "/t", { catalog: async () => [], log: () => {} });
    expect(r.status).toBe(401);
  });
  it("needs a session; an anonymous session cannot sign out (it would lose the account)", async () => {
    expect((await signout(req("/s", "POST"))).status).toBe(401);
    const { token } = await createSession();
    expect((await signout(req("/s", "POST", token))).status).toBe(400);
  });
});

describe("/api/account/devices", () => {
  it("needs a session", async () => {
    expect((await listDevices(req("/d", "GET"))).status).toBe(401);
    expect((await removeDevice(req("/d", "DELETE", undefined, { id: "x" }))).status).toBe(401);
  });
  it("removing a device needs step-up and ownership; the removed device is signed out", async () => {
    const auth = new SoftAuthenticator();
    const { device: a } = await createAccount(auth);
    const b = await signIn(auth);
    const other = await createAccount(new SoftAuthenticator());
    const target = (await devices(a)).find((d) => !d.current)!.id;
    const denied = await removeDevice(req("/d", "DELETE", a, { id: target }));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("step_up_required");
    expect((await removeDevice(req("/d", "DELETE", a, { nope: 1 }))).status).toBe(400);
    expect((await removeDevice(req("/d", "DELETE", other.device, { id: target }))).status).toBe(404);
    expect((await stepUp(auth, a)).status).toBe(200);
    const r = await removeDevice(req("/d", "DELETE", a, { id: target }));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await listDevices(req("/d", "GET", b))).status).toBe(401);
    expect(await devices(a)).toHaveLength(1);
  });
  it("removing the current device also clears its cookie", async () => {
    const auth = new SoftAuthenticator();
    const { device } = await createAccount(auth);
    const [me] = await devices(device);
    expect((await stepUp(auth, device)).status).toBe(200);
    const r = await removeDevice(req("/d", "DELETE", device, { id: me.id }));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("step-up is bound to the device that confirmed it", () => {
  it("a sign-in on device B grants no step-up to device A", async () => {
    const auth = new SoftAuthenticator();
    const { device: a } = await createAccount(auth);
    await signIn(auth);
    const target = (await devices(a)).find((d) => !d.current)!.id;
    const r = await removeDevice(req("/d", "DELETE", a, { id: target }));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("step_up_required");
  });
  it("a step-up made with device A's cookie confirms only for A", async () => {
    const auth = new SoftAuthenticator();
    const { device: a } = await createAccount(auth);
    const b = await signIn(auth);
    const [idA, idB] = [(await devices(a)).find((d) => d.current)!.id, (await devices(b)).find((d) => d.current)!.id];
    expect((await stepUp(auth, a)).status).toBe(200);
    expect((await removeDevice(req("/d", "DELETE", b, { id: idA }))).status).toBe(403);
    expect((await removeDevice(req("/d", "DELETE", a, { id: idB }))).status).toBe(200);
  });
});

describe("device activity", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("using a device only through the API keeps the account from the retention purge", async () => {
    const { id, device } = await createAccount(new SoftAuthenticator());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (RETENTION_DAYS + 30) * 86_400_000);
    await handleChat(new Request("http://app/x", { method: "POST", headers: { Authorization: `Bearer ${device}` }, body: "{}" }), "/t", { catalog: async () => [], log: () => {} });
    await purgeInactive();
    expect(await st.accounts.sessionExists(id)).toBe(true);
    expect(await devices(device)).toHaveLength(1);
  });
  it("a sign-in that fails half-way leaves this browser's old device signed in", async () => {
    const auth = new SoftAuthenticator();
    const { device } = await createAccount(auth);
    const opts = await (await loginOptions(req("/l", "POST", device, {}))).json();
    st.accounts.addDevice = async () => { throw new Error("store down"); };
    await expect(loginVerify(req("/l", "POST", device, auth.get(opts, ORIGIN)))).rejects.toThrow();
    expect((await listDevices(req("/d", "GET", device))).status).toBe(200);
  });
  it("a failed clean-up of the old device still signs this browser in", async () => {
    const auth = new SoftAuthenticator();
    const { device } = await createAccount(auth);
    let calls = 0;
    st.accounts.deleteDevice = async () => { calls++; throw new Error("store down"); };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const again = await signIn(auth, device);
      expect(calls).toBe(1);
      expect(again).not.toBe(device);
      const list = await devices(again);
      expect(list).toHaveLength(2); // the old one is left over, listed for the user to remove
      expect(list.filter((d) => d.current)).toHaveLength(1);
      expect(log.mock.calls.flat().join()).toContain("old_device_cleanup_failed");
    } finally { log.mockRestore(); }
  });
});

describe("export and delete include devices", () => {
  it("export lists devices; delete removes them", async () => {
    const auth = new SoftAuthenticator();
    const { id, device } = await createAccount(auth);
    await stepUp(auth, device);
    const d = await (await exportGET(req("/e", "GET", device))).json();
    expect(d.devices).toEqual([expect.objectContaining({ createdAt: expect.any(String), lastSeenOn: expect.any(String) })]);
    await st.accounts.deleteAccount(id);
    expect(await st.accounts.listDevices(id)).toEqual([]);
  });
});
