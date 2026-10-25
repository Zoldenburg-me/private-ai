"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadChats, saveChat, deleteChat, wipeAll, replaceChats, type Chat } from "@/lib/storage";
import { persist } from "@/lib/persist";
import { loadPersonas, savePersona, deletePersona, replacePersonas, type Persona } from "@/lib/personas";
import { encryptBackup, decryptBackup, type BackupFile } from "@/lib/backup";
import { newNonce, verifySignedResponse } from "@/lib/attestation";
import type { ModelEntry } from "@/lib/catalog";
import type { Tier } from "@/lib/tiers";
import type { Receipt } from "@/lib/sse";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Vault, idbKeyStore, MANAGED } from "@/lib/client/vault";
import { openHistory, readHandoff, withInvite } from "@/lib/client/guest";
import { DEFAULT_MODE, readModePrefs, readSidebarCollapsed, sidebarHidden, writeModePrefs, writeSidebarCollapsed, type ModePrefs } from "@/lib/client/ui-prefs";
import { AUTO, autoRef, autoRouteNote, levelModels, nextUnbench, resolveRef, signInUnlocks } from "@/lib/client/levels";
import { ToolsMenu } from "@/components/app/ToolsMenu";
import { autoCandidates, autoRetryDelay, fallbackOf, firstPassing, handoffReady, isBenched, ROUTE_COOLDOWN_MS, noEnclaveProof, proofFromResponse, signatureLevel, unsignedReason, isServerChecked, sdkProof, LEVEL_LABEL, type Proof } from "@/lib/client/proof";
import { ENABLED_PROVIDERS, autoEntryOf, autoModels, imagesFor, nearDefault } from "@/lib/client/providers";
import { ChatThread, type Signed } from "@/components/app/ChatThread";
import { ProofBadge } from "@/components/app/ProofBadge";
import { ProofDrawer } from "@/components/app/ProofDrawer";
import { ModelPicker, needsSignIn } from "@/components/app/ModelPicker";
import { PersonaGallery } from "@/components/app/PersonaGallery";
import { SettingsView, type AccountInfo, type Billing, type DeviceInfo } from "@/components/app/SettingsView";
import type { Usage } from "@/components/app/UsageMeter";
import { Sidebar } from "@/components/app/Sidebar";
import { DashboardView } from "@/components/app/DashboardView";
import { ChatScope } from "@/lib/chat-scope";
import Link from "next/link";
import { ChartBar, Cube, Ghost, List, Moon, NotePencil, Question, SidebarSimple, Sun, UserCirclePlus, UserFocus, X } from "@phosphor-icons/react";
import { PrivacyModes } from "@/components/app/PrivacyModes";

type View = "chat" | "dashboard" | "personas" | "settings";
const newChat = (): Chat => ({ id: crypto.randomUUID(), title: "New chat", messages: [], updatedAt: Date.now() });
/** Below this width the sidebar is an off-canvas drawer (phones and iPads in portrait). */
const NAV_MQ = "(max-width: 1024px)";
/** Below this width the proof drawer is a bottom sheet over the chat. */
const SHEET_MQ = "(max-width: 820px)";
/** Homepage hand-off: how long to wait for a model and its enclave check before only prefilling the prompt. */
const HANDOFF_WAIT_MS = 10_000;
/** Auto found no passing route: how long until it checks the routes again. */
const AUTO_RETRY_MS = 30_000;
const SUGGESTIONS = ["Draft a sensitive email", "Explain a test result", "Plan next month's budget", "How is this private?"];

export default function Home() {
  const [kv, setKv] = useState<Vault | null>(null);
  const [vaultError, setVaultError] = useState("");
  const [view, setView] = useState<View>("chat");
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat>(newChat);
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<Tier | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [incognitoUsage, setIncognitoUsage] = useState<Usage | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  // Privacy level, Auto or a pick per level, and tool settings (lib/client/ui-prefs.ts): saved like the sidebar preference below.
  const [mode, setMode] = useState<ModePrefs>(DEFAULT_MODE);
  const modeTouched = useRef(false);
  const updateMode = (patch: Partial<ModePrefs>) => { setMode((m) => ({ ...m, ...patch })); modeTouched.current = true; };
  // Routes whose chat failed at the provider, mirrored from routeFailedAt so Medium/Anon Auto re-picks on the next render.
  const [failedAt, setFailedAt] = useState<Record<string, number>>({});
  const [account, setAccount] = useState<AccountInfo | null>(null);
  // Signed-out visitors on the free plan: Auto routes only to models the server lets them use (the curated Auto line-up on TEE).
  const usable = models.filter((m) => !needsSignIn(m, account ? account.signedIn : undefined, tier ? tier.id !== "free" : undefined));
  const modelRef = resolveRef(usable, mode.level, mode.picks[mode.level], mode.pickProvider, failedAt);
  const autoOn = modelRef !== mode.picks[mode.level]; // Auto also covers a remembered pick the picker no longer offers
  const pick = (r: string) => updateMode({ picks: { ...mode.picks, [mode.level]: r } });
  const anonymized = models.find((m) => `${m.provider}:${m.id}` === modelRef)?.tee === false;
  const selectedPrivacy = models.find((m) => `${m.provider}:${m.id}` === modelRef)?.privacy;
  // The meter shows the quota the selected model counts against.
  const incognitoSelected = models.find((m) => `${m.provider}:${m.id}` === modelRef)?.incognito === true;
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState("");
  const [proofs, setProofs] = useState<Record<string, Proof>>({});
  // Auto routes whose chat failed at the provider; a ref, so a check that started before a failure sees it when it ends.
  const routeFailedAt = useRef<Record<string, number>>({});
  const candidates = useCallback((routes: string[]) => autoCandidates(routes, nearDefault(models), routeFailedAt.current), [models]);
  const [drawer, setDrawer] = useState(false);
  const [navOpen, setNavOpen] = useState(false); // narrow only: sidebar as a drawer
  const [narrow, setNarrow] = useState(false);
  const [sheet, setSheet] = useState(false); // proof drawer is a bottom sheet
  const [modes, setModes] = useState(false); // privacy modes dialog
  const [theme, setTheme] = useState<"light" | "dark" | null>(null); // null follows the system; memory only, never stored
  const [collapsed, setCollapsed] = useState(false); // wide only: sidebar hidden
  const [sessionDone, setSessionDone] = useState(false);
  const [pending, setPending] = useState(""); // hand-off prompt waiting for a model and its proof
  const [handoff, setHandoff] = useState<{ text: string; send: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const [invite, setInvite] = useState(""); // from an invite link; memory only, never stored
  const [passkeys, setPasskeys] = useState<{ id: string; label: string; createdAt: number }[] | null>([]); // null: the list could not be loaded
  const [modelsFailed, setModelsFailed] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [ghost, setGhost] = useState(false);
  const [ghostSearch, setGhostSearch] = useState(false); // ghost chat only, memory only
  const [searchAvailable, setSearchAvailable] = useState(false); // /api/session features.webSearch
  const [billing, setBilling] = useState<Billing | null>(null);
  const [sessionReady, setSessionReady] = useState(false); // evidence needs the session cookie
  const [scope] = useState(() => new ChatScope());
  /** Every chat switch goes through here so a running reply cannot follow into the next chat. */
  function openChat(next: Chat, nextGhost = ghost) { scope.switch(); setGhost(nextGhost); setChat(next); if (nextGhost) setGhostSearch(false); }

  useEffect(() => {
    // Homepage hand-off: the prompt only ever sits in the fragment; drop it from the address bar right away.
    const h = readHandoff(location);
    if (h.ghost) setGhost(true);
    if (h.prompt) setPending(h.prompt);
    if (h.invite) setInvite(h.invite);
    if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
    setCollapsed(readSidebarCollapsed()); setMode(readModePrefs());
    refreshSession();
    fetch("/api/models").then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((all: ModelEntry[]) => {
      setModels([...autoModels(all), ...all.filter((x) => (ENABLED_PROVIDERS as readonly string[]).includes(x.provider))]); // levelModels picks the rows per level
    }).catch(() => { setModelsFailed(true); setNotice("Could not load models. Reload to try again."); });
  }, []);

  // Open the encrypted local vault (non-extractable key in IndexedDB) once we know who this is. A signed-out
  // first visit gets no vault and chats in ghost mode: nothing is written to this browser until they sign up.
  const signedIn = !!account?.signedIn;
  useEffect(() => {
    if (!sessionDone || kv) return;
    let stale = false; // signing in meanwhile re-runs this with signedIn=true; the older answer is dropped
    openHistory(localStorage, idbKeyStore(), signedIn, { onError: (e) => setNotice(`Not saved to encrypted history: ${e.message}`) }).then((v) => {
      if (stale) return;
      if (!v) { setGhost(true); return; }
      setKv(v); setChats(loadChats(v)); setPersonas(loadPersonas(v));
    }).catch((e) => { if (!stale) setVaultError(`Encrypted storage unavailable (${(e as Error).message}). Use ghost chat.`); });
    return () => { stale = true; };
  }, [sessionDone, signedIn, kv]);

  // Vault writes finish asynchronously; warn before a reload or close would drop one.
  useEffect(() => {
    if (!kv) return;
    const onUnload = (e: BeforeUnloadEvent) => { if (kv.pending()) e.preventDefault(); };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [kv]);

  // Another tab changed the encrypted history: adopt it, so this tab's next write cannot undo it (e.g. a deletion).
  useEffect(() => {
    if (!kv) return;
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return;
      const keys = e.key === null ? MANAGED : MANAGED.filter((k) => k === e.key);
      void Promise.all(keys.map((k) => kv.reload(k))).then((changed) => {
        if (!changed.some(Boolean)) return;
        const cs = loadChats(kv); setChats(cs); setPersonas(loadPersonas(kv));
        // The open chat was deleted or wiped in the other tab: close it instead of saving it back.
        if (!ghost && chat.messages.length && !cs.some((c) => c.id === chat.id)) { scope.forget(chat.id); openChat(newChat()); }
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  });

  function refreshSession() {
    fetch("/api/session").then((r) => r.json()).then((s) => {
      if (!s.error) setSessionReady(true); // a 429/503 sets no cookie, so evidence would only 401
      else setNotice("Could not reach your session: plan, usage and sign-in status are unknown. Reload to try again.");
      setTier(s.tier); setAccount(s.account ?? null); setSearchAvailable(s.features?.webSearch === true);
      if (s.usage) setUsage({ remaining: s.usage.remainingToday, limit: s.usage.dailyLimit });
      setIncognitoUsage(s.incognitoUsage ? { remaining: s.incognitoUsage.remainingToday, limit: s.incognitoUsage.dailyLimit, incognito: true } : null);
      fetch("/api/billing").then((r) => r.json()).then(setBilling).catch(() => {});
      if (s.account?.signedIn) fetch("/api/account/devices").then((r) => r.json()).then((d) => setDevices(d.devices ?? [])).catch(() => {});
      else setDevices([]);
      // A failed list must not read as "no passkey left".
      return fetch("/api/auth/passkey").then((r) => (r.ok ? r.json() : Promise.reject())).then((p) => setPasskeys(Array.isArray(p.passkeys) ? p.passkeys : null), () => setPasskeys(null));
    }).catch(() => setNotice("Could not reach your session: plan, usage and sign-in status are unknown. Reload to try again.")).finally(() => setSessionDone(true));
  }

  const checkProof = useCallback(async (ref: string): Promise<Proof | null> => {
    if (!ref || !models.length) return null; // the catalog decides whether this model has an enclave at all
    const unavailable = (r: string): Proof => ({ modelRef: r, level: "unavailable", label: LEVEL_LABEL.unavailable, chainVerified: false, checkedAt: Date.now(), reports: [], notVerified: [] });
    // One provider ref, no state: null means no session yet, so nothing is cached and the next check retries.
    const one = async (r: string): Promise<Proof | null> => {
      if (models.find((m) => `${m.provider}:${m.id}` === r)?.tee === false) return noEnclaveProof(r);
      const nonce = newNonce();
      try {
        const res = await fetch(`/api/attestation?model=${encodeURIComponent(r)}&nonce=${nonce}`);
        if (res.status === 401) return null;
        if (!res.ok) return unavailable(r);
        const body: unknown = await res.json();
        // Tinfoil, Privatemode: pass only if the SDK on our server holds a verified attestation; a broken route is unavailable, so Auto moves on.
        if (isServerChecked(r)) return sdkProof(r, body);
        return proofFromResponse(r, body, nonce);
      } catch {
        return unavailable(r);
      }
    };
    const auto = autoEntryOf(models, ref);
    let proof: Proof | null;
    if (auto) {
      // Cheapest route whose proof holds; its modelRef is where messages go. State is set once, at the end:
      // setting it per route re-ran the check effect before this ref was stored (render loop).
      let noSession = false;
      const won = await firstPassing(candidates(auto.routes), async (r) => { const p = await one(r); if (!p) noSession = true; return p; });
      proof = won ?? (noSession ? null : unavailable(ref));
      // A route benched while this check ran must not come back: the check the failure started decides instead.
      if (won && isBenched(won.modelRef, routeFailedAt.current)) return null;
    } else proof = await one(ref);
    if (!proof) return null;
    const done = proof;
    setProofs((p) => ({ ...p, [ref]: done, [done.modelRef]: done })); // the route's own key serves its signature checks
    return proof;
  }, [models, candidates]);

  // An Auto route that failed a chat at the provider is skipped for a while: drop the cached choice so Auto picks again.
  // Keyed on the failed route, not the current selection, so a model switch mid-reply still benches it, and every
  // Auto choice that sends there (not only this one) picks again.
  // An "unavailable" Auto proof goes too, so a check always follows. The notice is about the current selection (read
  // from a ref: ChatThread holds the callback of the render its reply started in), and only if it uses that route.
  const incognitoAuto = autoOn && mode.level !== "max";
  const selection = useRef({ modelRef, models, proofs, incognitoAuto, level: mode.level }); selection.current = { modelRef, models, proofs, incognitoAuto, level: mode.level };
  const onProviderFailure = useCallback((ref: string) => {
    routeFailedAt.current = { ...routeFailedAt.current, [ref]: Date.now() };
    setFailedAt(routeFailedAt.current);
    setProofs((p) => Object.fromEntries(Object.entries(p).filter(([k, v]) => !(k.startsWith("auto:") && (v.modelRef === ref || v.level === "unavailable")))));
    const { modelRef: now, models: all, proofs: cached, incognitoAuto: onList, level } = selection.current;
    if (onList && now === ref) {
      setNotice(autoRef(all, level, routeFailedAt.current)
        ? "Auto: that model failed at the provider, so Auto moves to the next one on its list. Send again."
        : `Auto: every model on this level failed at its provider in the last few minutes. It tries again in about ${ROUTE_COOLDOWN_MS / 60_000} minutes.`);
      return;
    }
    const auto = autoEntryOf(all, now);
    if (!auto || cached[now]?.modelRef !== ref) return; // only if this selection was sending there
    setNotice(candidates(auto.routes).length
      ? "Auto: that provider failed, so it switches to the next enclave (NEAR AI Cloud last). Send again once the badge shows a proof."
      : `Auto: every enclave for ${auto.name.replace(/^Auto · /, "")} failed in the last few minutes. It tries again in about ${ROUTE_COOLDOWN_MS / 60_000} minutes.`);
  }, [candidates]);

  useEffect(() => { if (sessionReady && modelRef && !proofs[modelRef]) void checkProof(modelRef); }, [sessionReady, modelRef, proofs, checkProof]);
  // Medium/Anon Auto with every model benched has nothing to send to (Send is off): pick again once the first one is back.
  useEffect(() => {
    if (!incognitoAuto || modelRef) return;
    const ms = nextUnbench(failedAt);
    if (ms === undefined) return;
    const t = setTimeout(() => setFailedAt({ ...routeFailedAt.current }), ms + 50);
    return () => clearTimeout(t);
  }, [incognitoAuto, modelRef, failedAt]);
  // Auto with no passing route (e.g. a brief attestation outage) leaves Send disabled: check again after a pause,
  // until a route passes or the selection changes (the cleanup cancels the pending retry).
  // Off its cheapest route (another route or the NEAR fallback), check again once benched routes are back.
  const autoEntry = autoEntryOf(models, modelRef);
  const autoProof = autoEntry ? proofs[modelRef] : undefined;
  const fallbackRef = fallbackOf(autoEntry?.routes, autoProof);
  const [retryTick, setRetryTick] = useState(0); // a re-check that stored nothing (e.g. a 401) still arms the next one
  useEffect(() => {
    const delay = autoEntry ? autoRetryDelay(autoProof, autoEntry.routes, AUTO_RETRY_MS) : 0;
    if (!sessionReady || !delay) return;
    const t = setTimeout(() => void checkProof(modelRef).then((p) => { if (!p) setRetryTick((n) => n + 1); }), delay);
    return () => clearTimeout(t);
  }, [sessionReady, modelRef, autoEntry, autoProof, checkProof, retryTick]);
  // Say so when Auto lands on the NEAR fallback (a model other than the one picked), and when it is back on its own route.
  const lastFallback = useRef({ modelRef: "", fallbackRef: "" });
  useEffect(() => {
    const was = lastFallback.current;
    // Proof cleared for a re-pick, or nothing passes for now: remember where it was, for "back on".
    if (autoEntry && (!autoProof || autoProof.level === "unavailable") && was.modelRef === modelRef) return;
    lastFallback.current = { modelRef, fallbackRef };
    if (!autoEntry || !autoProof) return;
    const name = (ref: string) => models.find((x) => `${x.provider}:${x.id}` === ref)?.name ?? ref;
    const picked = autoEntry.name.replace(/^Auto · /, "");
    if (fallbackRef) setNotice(`Auto: no enclave for ${picked} is available right now, so this chat uses ${name(fallbackRef)} on NEAR AI Cloud.`);
    else if (was.modelRef === modelRef && was.fallbackRef && autoProof.level !== "unavailable") setNotice(`Auto: back on ${picked}.`);
  }, [modelRef, fallbackRef, autoProof?.modelRef]); // eslint-disable-line react-hooks/exhaustive-deps -- once per selection and route, not on every catalog or proof change

  const verifySignature = useCallback(async (receipt: Receipt, modelRef: string): Promise<Signed> => {
    const ref = `${receipt.provider}:${receipt.model}`;
    if (ref !== modelRef) return "n/a"; // a receipt for another model than the turn was sent to proves nothing about this reply
    const a = proofs[ref] ?? await checkProof(ref);
    // A gateway-only proof's key is the gateway's: a match would not mean the model's enclave signed the reply.
    if (!a || a.level === "failed" || a.level === "unavailable" || a.level === "gateway-checked" || !a.signingAddress || !receipt.chat_id) return a ? unsignedReason(a.level) : "n/a";
    const r = await fetch(`/api/signature?model=${encodeURIComponent(ref)}&chat_id=${encodeURIComponent(receipt.chat_id)}`);
    if (!r.ok) return "n/a";
    return signatureLevel(a, verifySignedResponse(await r.json(), a.signingAddress, { reqSha256: receipt.req_sha256, respSha256: receipt.resp_sha256 }).ok);
  }, [proofs, checkProof]);

  const onSaved = useCallback((c: Chat, wasGhost: boolean, isCurrent: boolean) => {
    if (isCurrent) setChat(c);
    if (!kv) return;
    const saved = persist(kv, { ghost: wasGhost }, (w) => saveChat(w, c)); if (saved) setChats(saved);
  }, [kv]);

  function startChat(opts: { ghost?: boolean; personaId?: string } = {}) {
    if (opts.personaId !== undefined) setPersonaId(opts.personaId);
    openChat(newChat(), !!opts.ghost); setView("chat");
  }

  function addPersona(name: string, systemPrompt: string): boolean {
    if (!kv) return false;
    try {
      const next = persist(kv, { ghost }, (w) => savePersona(w, { id: crypto.randomUUID(), name, systemPrompt, createdAt: Date.now() }));
      if (next) { setPersonas(next); return true; }
      setNotice("Leave ghost chat to save personas"); return false;
    } catch (e) { setNotice((e as Error).message); return false; }
  }
  function removePersona(id: string) {
    if (!kv) return; const n = persist(kv, { ghost }, (w) => deletePersona(w, id)); if (n) setPersonas(n);
  }

  async function exportBackup(pass: string) {
    if (!kv) return;
    try {
      const file = await encryptBackup({ chats: loadChats(kv), personas: loadPersonas(kv) }, pass);
      const check = await decryptBackup<{ chats: Chat[] }>(file, pass);
      const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `private-ai-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
      setNotice(`Encrypted backup exported and verified (${check.chats.length} chats)`);
    } catch (e) { setNotice((e as Error).message); }
  }
  async function importBackup(f: File, pass: string) {
    if (!kv) return;
    if (!pass) { setNotice("Enter the backup passphrase first"); return; }
    try {
      const data = await decryptBackup<{ chats: Chat[]; personas: Persona[] }>(JSON.parse(await f.text()) as BackupFile, pass);
      const ok = persist(kv, { ghost }, (w) => { replaceChats(w, data.chats ?? []); replacePersonas(w, data.personas ?? []); return true; });
      if (!ok) { setNotice("Leave ghost chat to restore a backup"); return; }
      // Show what the vault now holds even if one of the two writes failed (flush() names the unsaved key).
      try { await kv.flush(); setNotice("Backup restored"); }
      finally { setChats(loadChats(kv)); setPersonas(loadPersonas(kv)); }
    } catch (e) { setNotice((e as Error).message); }
  }
  async function wipe() {
    if (!kv || ghost) return;
    scope.discardAll(); // a reply still streaming or finishing must not write a wiped chat back
    persist(kv, { ghost }, (w) => wipeAll(w));
    setChats([]); openChat(newChat());
    try { await kv.flush(); setNotice("All chats wiped from this browser"); } catch (e) { setNotice((e as Error).message); }
  }
  async function goBilling(path: string, body: object = {}) {
    try {
      const r = await withStepUp(() => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      const j = await r.json(); if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
      window.location.href = j.url;
    } catch (e) { setNotice(`Billing: ${(e as Error).message}`); }
  }
  const errorOf = async (r: Response) => (await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`;
  /** Sensitive account actions: if the server asks for a fresh passkey login, do it and retry once. */
  async function withStepUp(run: () => Promise<Response>): Promise<Response> {
    const r = await run();
    if (r.status !== 403 || (await r.clone().json().catch(() => null))?.error?.code !== "step_up_required") return r;
    setNotice("Confirm with one of your passkeys");
    return (await loginPasskey(true)) ? run() : r;
  }
  /** The first passkey creates the account (this browser becomes a signed-in device); no email or username. */
  async function addPasskey() {
    try {
      const options = (code?: string) => fetch("/api/auth/passkey/register/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite: code }) });
      const o = await withInvite((code) => withStepUp(() => options(code)), invite, (m) => window.prompt(m), () => setInvite(""));
      if (!o) { setNotice("Invite code required"); return; }
      if (!o.ok) throw new Error((await o.json()).error?.message ?? `HTTP ${o.status}`);
      const att = await startRegistration({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/passkey/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(att) });
      if (!v.ok) throw new Error((await v.json()).error?.message ?? `HTTP ${v.status}`);
      setInvite("");
      setNotice(account?.signedIn ? "Passkey added." : "Account created. Sign in with this passkey on your other devices."); refreshSession();
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); }
  }
  async function loginPasskey(stepUp = false): Promise<boolean> {
    try {
      const o = await fetch("/api/auth/passkey/login/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stepUp }) });
      if (!o.ok) throw new Error(`HTTP ${o.status}`);
      const asr = await startAuthentication({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/passkey/login/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(asr) });
      if (!v.ok) throw new Error((await v.json()).error?.message ?? `HTTP ${v.status}`);
      if (!stepUp) { setNotice("Signed in"); refreshSession(); }
      return true;
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); return false; }
  }
  async function removePasskey(id: string) {
    const r = await withStepUp(() => fetch("/api/auth/passkey", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }));
    if (r.ok) { setNotice("Passkey removed"); refreshSession(); } else setNotice(`Passkey: ${await errorOf(r)}`);
  }
  /** Revokes this browser's device token server-side. Local chats stay: they were never tied to the account. */
  async function signOut() {
    const r = await fetch("/api/auth/signout", { method: "POST" });
    if (!r.ok) { setNotice(`Sign out: ${await errorOf(r)}`); return; }
    setNotice("Signed out. Chats in this browser are kept.");
    setBilling(null); setPasskeys([]); setDevices([]); refreshSession();
  }
  async function removeDevice(id: string) {
    const r = await withStepUp(() => fetch("/api/account/devices", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }));
    if (!r.ok) { setNotice(`Device: ${await errorOf(r)}`); return; }
    const wasMe = devices.some((d) => d.id === id && d.current);
    setNotice(wasMe ? "Signed out. Chats in this browser are kept." : "Device signed out.");
    if (wasMe) { setBilling(null); setPasskeys([]); }
    refreshSession();
  }
  /** GDPR Art. 15/20: everything the server holds for this account, as a JSON file. */
  async function downloadAccountData() {
    const r = await withStepUp(() => fetch("/api/account/export"));
    if (!r.ok) { setNotice(`Export: ${await errorOf(r)}`); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a"); a.href = url; a.download = "private-ai-account.json"; a.click();
    URL.revokeObjectURL(url);
  }
  /** GDPR Art. 17: deletes the server-side account and its Stripe customer. Local chats stay until wiped. */
  async function deleteAccount() {
    const r = await withStepUp(() => fetch("/api/account", { method: "DELETE" }));
    if (!r.ok) { setNotice(`Delete: ${await errorOf(r)}`); return; }
    setNotice("Account deleted on the server. Chats in this browser are kept until you wipe them.");
    setBilling(null); setPasskeys([]); setDevices([]); refreshSession();
  }

  const persona = personas.find((p) => p.id === personaId);
  const proof = proofs[modelRef] ?? null;
  // Auto sends to the route whose proof passed; until one has, there is nothing to send to.
  const sendRef = !modelRef.startsWith("auto:") ? modelRef : proof && proof.modelRef !== modelRef ? proof.modelRef : "";
  const routeNote = autoRouteNote({ models: usable, ref: modelRef, auto: autoOn, proof: proofs[modelRef], failedAt, level: mode.level })
    ?? (autoOn && !modelRef && signInUnlocks(models, usable, mode.level) ? "Sign in to use the models on this level." : undefined);
  // Web search: on by default (Settings can turn it off); in ghost chat off until switched on in the "+" menu, never saved.
  const searchPref = ghost ? ghostSearch : mode.webSearch;
  const webSearch = searchAvailable && searchPref;
  const filtered = useMemo(() => chats.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())), [chats, query]);
  // Incognito models have their own quota, so the limit comes from the same response as the remaining count.
  const onUsage = useCallback((rem: string | null, limit?: string | null, quota?: string | null) => {
    const remaining = Number(rem); const max = Number(limit);
    if (rem == null || rem.trim() === "" || !Number.isFinite(remaining)) return;
    const incognito = quota === "incognito";
    (incognito ? setIncognitoUsage : setUsage)((u) => ({ remaining, limit: max > 0 ? max : u?.limit, ...(incognito ? { incognito } : {}) }));
  }, []);

  const go = (v: View) => { if (v !== view) setDrawer(false); setView(v); setNavOpen(false); };
  /** Saving and history need an account: say so and show where to create one, never block the chat. */
  const promptSignup = (why: string) => { setNotice(`${why} Create an account with a passkey: no email, no password.`); go("settings"); };

  // Homepage hand-off: send once a model is chosen and its enclave check is in; otherwise only prefill.
  // No hand-off to a gateway-only proof: the prompt would be sent before anyone chose a model that is not attested.
  // Nor when Auto fell back to a different model: the user has not seen that yet, so only prefill.
  const proofReady = handoffReady(proof, fallbackRef);
  useEffect(() => {
    if (!pending) return;
    const give = (send: boolean) => { setHandoff({ text: pending, send }); setPending(""); };
    if (modelRef && sessionReady && proofReady) { give(true); return; }
    const t = setTimeout(() => give(false), HANDOFF_WAIT_MS);
    return () => clearTimeout(t);
  }, [pending, modelRef, sessionReady, proofReady]);

  useEffect(() => {
    const mq = matchMedia(NAV_MQ); const sq = matchMedia(SHEET_MQ);
    const apply = () => { setNarrow(mq.matches); setSheet(sq.matches); if (!mq.matches) setNavOpen(false); };
    const all = [mq, sq];
    apply(); all.forEach((q) => q.addEventListener("change", apply));
    return () => all.forEach((q) => q.removeEventListener("change", apply));
  }, []);
  // The proof sheet floats over the chat, so it never takes the sidebar's place.
  const sideHidden = sidebarHidden({ narrow, cramped: false, drawer, collapsed });
  const navShown = narrow ? navOpen : !sideHidden;
  function toggleNav() {
    if (narrow) { setNavOpen((o) => !o); return; }
    setCollapsed(!collapsed); sidebarTouched.current = true;
  }
  // Remember the user's choice, only outside ghost chat and once this browser keeps history (a signed-out
  // first visit writes nothing, not even a display setting);
  // a choice made in ghost chat is saved once they leave it.
  const sidebarTouched = useRef(false);
  useEffect(() => { // saved once per toggle, so a stale value never overwrites another tab's later choice
    if (!ghost && kv && sidebarTouched.current) { writeSidebarCollapsed(collapsed); sidebarTouched.current = false; }
  }, [ghost, kv, collapsed]);
  useEffect(() => { // same rule for the privacy level, model picks and tool settings
    if (!ghost && kv && modeTouched.current) { writeModePrefs(mode); modeTouched.current = false; }
  }, [ghost, kv, mode]);

  // Narrow: the nav is an off-canvas drawer (and below 820px the proof drawer a bottom sheet): keep focus out of
  // whatever is hidden or covered, move it into the drawer on open and back to the menu button on close.
  const sheetRef = useRef<HTMLDivElement>(null); const mainRef = useRef<HTMLElement>(null); const menuRef = useRef<HTMLButtonElement>(null);
  const navWasOpen = useRef(false);
  useEffect(() => {
    if (sheetRef.current) sheetRef.current.inert = narrow && !navOpen;
    if (mainRef.current) mainRef.current.inert = (narrow && navOpen) || (drawer && sheet);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && navOpen) setNavOpen(false); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [navOpen, drawer, narrow, sheet]);
  useEffect(() => {
    if (navOpen && narrow) sheetRef.current?.querySelector<HTMLElement>(".side-item")?.focus();
    if (!navOpen && navWasOpen.current && narrow) menuRef.current?.focus(); // not when widening closed it
    navWasOpen.current = navOpen;
  }, [navOpen, narrow]);
  useEffect(() => {
    const el = document.documentElement;
    if (theme) el.dataset.theme = theme; else delete el.dataset.theme;
    return () => { delete el.dataset.theme; };
  }, [theme]);
  const [systemDark, setSystemDark] = useState(false); // read after mount, so server and client render the same label
  useEffect(() => {
    const q = matchMedia("(prefers-color-scheme: dark)"); const on = () => setSystemDark(q.matches);
    on(); q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  const dark = theme ? theme === "dark" : systemDark;
  const toggleGhost = () => {
    if (ghost && !kv && !signedIn) { promptSignup("Sign up to save chats in this browser."); return; }
    startChat({ ghost: !ghost }); setNavOpen(false);
  };
  const TITLES: Record<View, string> = { chat: "", dashboard: "Dashboard", personas: "Personas", settings: "Account" };
  const title = view !== "chat" ? TITLES[view] : ghost ? "Ghost chat: not saved" : chat.messages.length ? chat.title : "";
  const NAV = [
    { v: "dashboard" as const, label: "Dashboard", Icon: ChartBar },
    { v: "personas" as const, label: "Personas", Icon: UserFocus },
  ];
  const navBtn = ({ v, label, Icon }: { v: View; label: string; Icon: typeof ChartBar }) => (
    <button key={v} type="button" className={`side-item ${view === v ? "on" : ""}`} data-testid={`nav-${v}`} onClick={() => go(v)}
      aria-current={view === v ? "page" : undefined}><Icon weight={view === v ? "fill" : "duotone"} aria-hidden />{label}</button>
  );

  return (
    <div className={`app ${drawer ? "with-drawer" : ""} ${ghost ? "is-ghost" : ""} ${navOpen ? "nav-open" : ""} ${sideHidden ? "side-collapsed" : ""}`}>
      <div className="nav-sheet" id="app-nav" ref={sheetRef}>
        <Sidebar ghost={ghost} query={query} onQuery={setQuery} chats={filtered} currentId={chat.id} vaultError={vaultError}
          tier={tier} usage={incognitoSelected ? incognitoUsage : usage} account={account} accountOn={view === "settings"} onAccount={() => go("settings")}
          onCollapse={toggleNav}
          nav={<><Link href="/models" className="side-item"><Cube weight="duotone" aria-hidden />Models</Link>{NAV.map(navBtn)}</>}
          onNew={() => { startChat(); setNavOpen(false); }}
          onOpen={(c) => { openChat(c, false); go("chat"); }}
          onDelete={(c) => { if (!kv) return; scope.forget(c.id); const n = persist(kv, { ghost }, (w) => deleteChat(w, c.id)); if (n) setChats(n); if (c.id === chat.id) openChat(newChat()); }} />
      </div>
      <button type="button" className="nav-scrim" aria-label="Close menu" inert={!navOpen} onClick={() => setNavOpen(false)} />

      <main className="main" ref={mainRef}>
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" ref={menuRef} data-testid="nav-toggle" aria-label={narrow ? "Menu" : "Open sidebar"}
            aria-expanded={navShown} aria-controls="app-nav" onClick={toggleNav}>{narrow ? <List aria-hidden /> : <SidebarSimple weight="duotone" aria-hidden />}</button>
          <button type="button" className="icon-btn menu-btn" aria-label="New chat" onClick={() => startChat()}><NotePencil weight="duotone" aria-hidden /></button>
          <span className="top-title">{title}</span>
          {persona && <span className="chip" data-testid="persona-chip"><UserFocus aria-hidden />{persona.name}<button type="button" className="chip-x" aria-label="Clear persona" onClick={() => setPersonaId("")}><X aria-hidden /></button></span>}
          <div className="grow" />
          {sessionDone && !signedIn && view !== "settings" && <button type="button" className="btn signup-btn" data-testid="signup" onClick={() => go("settings")}><UserCirclePlus aria-hidden className="signup-ico" /><span className="signup-label">Sign up</span></button>}
          {view === "chat" && <ProofBadge proof={proof} onOpen={() => setDrawer((d) => !d)} />}
          <button type="button" className="icon-btn top-btn" aria-label="Privacy modes explained" title="Privacy modes explained" onClick={() => setModes(true)}><Question weight="duotone" aria-hidden /></button>
          <button type="button" className="icon-btn top-btn" aria-label={dark ? "Light mode" : "Dark mode"} title={dark ? "Light mode" : "Dark mode"}
            onClick={() => setTheme(dark ? "light" : "dark")}>{dark ? <Sun weight="duotone" aria-hidden /> : <Moon weight="duotone" aria-hidden />}</button>
        </header>
        {/* The live region stays mounted so screen readers announce text added to it. */}
        <div role="status" className="notice-slot">
          {notice && (
            <div className="notice" data-testid="notice">
              <span>{notice}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNotice("")}><X aria-hidden /></button>
            </div>
          )}
        </div>

        {view === "chat" && (
          kv || ghost
            ? <ChatThread key={chat.id + (ghost ? ":g" : "")} scope={scope} chat={chat} modelRef={sendRef} persona={persona} ghost={ghost}
                onSaved={onSaved} onUsage={onUsage} verifySignature={verifySignature} onProviderFailure={onProviderFailure}
                handoff={handoff} onHandoff={() => setHandoff(null)}
                hint={sessionDone && !signedIn && invite ? <>You&apos;re invited. <button type="button" className="link" data-testid="invite-hint" onClick={() => go("settings")}>Create your account</button>: a passkey and an account ID.</>
                  : sessionDone && !signedIn && ghost ? <>Nothing from this chat is saved. <button type="button" className="link" data-testid="signup-hint" onClick={() => promptSignup("Sign up to save chats.")}>Sign up to save chats</button></> : undefined}
                anonymized={anonymized} suggestions={anonymized ? SUGGESTIONS.filter((s) => !/private/i.test(s)) : SUGGESTIONS}
                onOpenProof={() => setDrawer(true)}
                incognito={selectedPrivacy === "private" || selectedPrivacy === "anonymized" ? selectedPrivacy : undefined}
                ghostToggle={<button type="button" className={`tool-toggle ${ghost ? "on" : ""}`} data-testid="ghost-toggle" aria-pressed={ghost} title="Ghost chat: never saved" onClick={toggleGhost}>
                  <Ghost weight={ghost ? "fill" : "duotone"} aria-hidden /><span className="tool-toggle-label">{ghost ? "Ghost on" : "Ghost"}</span></button>}
                webSearch={webSearch}
                images={imagesFor(models, modelRef, sendRef)}
                toolsSlot={<ToolsMenu available={searchAvailable} webSearch={searchPref} ghost={ghost} onWebSearch={(on) => (ghost ? setGhostSearch(on) : updateMode({ webSearch: on }))} />}
                modelSlot={<ModelPicker models={levelModels(models, mode.level, mode.pickProvider)} value={modelRef} onChange={pick} paidPlan={tier ? tier.id !== "free" : undefined} signedIn={account ? account.signedIn : undefined} onExplain={() => setModes(true)} level={proof?.level} loadFailed={modelsFailed}
                  privacy={{ level: mode.level, onLevel: (l) => updateMode({ level: l }), auto: autoOn, onAuto: () => pick(AUTO), note: routeNote }} />} />
            : vaultError ? <div className="loading bad">{vaultError}</div> : <div className="loading muted">Unlocking encrypted history…</div>
        )}
        {view === "dashboard" && (
          <DashboardView tier={tier} usage={usage} incognitoUsage={incognitoUsage} chats={chats} models={models} proofs={proofs} renewsAt={billing?.subscription?.status === "active" ? billing.subscription.currentPeriodEnd : null} />
        )}
        {view === "personas" && (
          <PersonaGallery personas={personas} disabled={ghost || !kv} onAdd={addPersona} onDelete={removePersona}
            onUse={(id) => startChat({ personaId: id })} />
        )}
        {view === "settings" && (
          <SettingsView tier={tier} usage={usage} billing={billing} passkeys={passkeys} ghost={ghost}
            account={account} devices={devices} onSignOut={signOut} onRemoveDevice={removeDevice}
            onCheckout={(plan, interval) => goBilling("/api/billing/checkout", { plan, interval })}
            onPortal={() => goBilling("/api/billing/portal")}
            onAddPasskey={addPasskey} onLoginPasskey={() => void loginPasskey()} onRemovePasskey={removePasskey}
            onExportAccount={downloadAccountData} onDeleteAccount={deleteAccount}
            onExport={exportBackup} onImport={importBackup} onWipe={wipe}
            tools={{ available: searchAvailable, webSearch: mode.webSearch, onWebSearch: (on) => updateMode({ webSearch: on }), pickProvider: mode.pickProvider, onPickProvider: (on) => updateMode({ pickProvider: on }) }} />
        )}
      </main>

      {drawer && <button type="button" className="proof-scrim" aria-label="Close enclave proof" tabIndex={-1} onClick={() => setDrawer(false)} />}
      <ProofDrawer proof={proof} open={drawer} onClose={() => setDrawer(false)} onRecheck={() => void checkProof(modelRef)} onExplain={() => setModes(true)}
        modelName={models.find((m) => `${m.provider}:${m.id}` === modelRef)?.name} privacy={selectedPrivacy} autoNote={routeNote} />
      {modes && <PrivacyModes onClose={() => setModes(false)} />}
    </div>
  );
}
