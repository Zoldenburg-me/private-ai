/**
 * N0 spike (docs/e2e-enclave-encryption.md §9): a live probe of NEAR AI Cloud E2EE v2 with our own sealing code.
 * Sends only fixed, content-free test prompts and prints a pass/fail line per check; replies are checked in memory
 * and never printed. The key is read from the environment and never printed.
 *   NEAR_AI_API_KEY=… npx vite-node scripts/near-e2ee-probe.ts [--model <text model>] [--vision <image model>] [--reports 4]
 * Needs Node 22.2+ (zlib.crc32).
 */
import { request } from "node:https";
import { deflateSync, crc32 } from "node:zlib";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { mapReplyFields, nearKey, openField, openReply, sealField, sealRequest } from "../lib/client/e2e/near";
import { collateralQuery, verifyTdxQuote, type Collateral } from "../lib/client/e2e/dcap";
import { newNonce, parseTdxQuote, verifySignedResponse } from "../lib/attestation";
import { NEAR_SEARCH_TOOL } from "../lib/near-search";

const BASE = "https://cloud-api.near.ai/v1";
const KEY = process.env.NEAR_AI_API_KEY ?? "";
if (!KEY) throw new Error("NEAR_AI_API_KEY is not set");
const AUTH = { Authorization: `Bearer ${KEY}` };
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const TEXT_PREFS = ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "Qwen/Qwen3.8-27B", "z-ai/glm-5.3"];
const VISION = arg("vision") ?? "Qwen/Qwen3.8-27B";
const REPORTS = Number(arg("reports") ?? 4);
if (!Number.isInteger(REPORTS) || REPORTS < 1) throw new Error("--reports must be a positive integer");

type Row = { check: string; ok: boolean | null; detail: string };
const rows: Row[] = [];
/** ok null = observation, not a pass/fail. Never pass reply text or the key in `detail`. */
const mask = (s: string) => (KEY ? s.split(KEY).join("***") : s);
const note = (check: string, ok: boolean | null, detail = "") => {
  detail = mask(detail);
  rows.push({ check, ok, detail });
  if (ok === false) process.exitCode = 1;
  console.log(`${ok === null ? "  ·" : ok ? "  ✓" : "  ✗"} ${check}${detail ? ` — ${detail}` : ""}`);
};
const HEXF = /^(?:[0-9a-f]{2}){72,}$/i; // at least ephemeral_pub ‖ nonce ‖ tag

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(BASE + path, { headers: AUTH, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { raw: mask(text.slice(0, 200)) } }; }
}

type Report = { provider?: string; trust?: string; signing_public_key?: string; signing_address: string; intel_quote: string; nvidia_payload?: string; request_nonce?: string; model_name?: string };
async function report(model: string, algo: "ed25519" | "ecdsa", nonce = newNonce()) {
  const t = performance.now();
  const { status, json } = await get(`/attestation/report?model=${encodeURIComponent(model)}&signing_algo=${algo}&nonce=${nonce}`);
  const all = (Array.isArray(json.model_attestations) ? json.model_attestations : []) as Report[];
  // A lone entry without a name is taken as the model's; several entries must name it, or none is used.
  return { status, ms: performance.now() - t, nonce, json, all, entry: all.find((a) => a.model_name === model) ?? (all.length === 1 && !all[0].model_name ? all[0] : undefined) };
}

/** Intel collateral for one quote, as lib/collateral.ts fetches it (dcap-qvl QuoteCollateralV3 fields). */
async function collateral(quote: Uint8Array): Promise<Collateral> {
  const { fmspc, ca } = collateralQuery(quote);
  const PCS = "https://api.trustedservices.intel.com";
  const fetchOk = async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) { await r.body?.cancel(); throw new Error(`${url} → ${r.status}`); }
    return r;
  };
  const der = async (url: string) => Buffer.from(await (await fetchOk(url)).arrayBuffer()).toString("hex");
  const signed = async (url: string, field: string, header: string) => {
    const r = await fetchOk(url);
    const m = new RegExp(`^\\{"${field}":(\\{[\\s\\S]*\\}),"signature":"([0-9a-fA-F]{128})"\\}$`).exec(await r.text());
    if (!m) throw new Error(`${url}: unexpected format`);
    const chain = r.headers.get(header);
    if (!chain) throw new Error(`${url}: no ${header}`);
    return [m[1], m[2], decodeURIComponent(chain)];
  };
  const [tcb, tcbSig, tcbChain] = await signed(`${PCS}/tdx/certification/v4/tcb?fmspc=${fmspc}`, "tcbInfo", "TCB-Info-Issuer-Chain");
  const [qe, qeSig, qeChain] = await signed(`${PCS}/tdx/certification/v4/qe/identity`, "enclaveIdentity", "SGX-Enclave-Identity-Issuer-Chain");
  return {
    root_ca_crl: await der("https://certificates.trustedservices.intel.com/IntelSGXRootCA.der"),
    pck_crl: await der(`${PCS}/sgx/certification/v4/pckcrl?ca=${ca}&encoding=der`),
    tcb_info: tcb, tcb_info_signature: tcbSig, tcb_info_issuer_chain: tcbChain,
    qe_identity: qe, qe_identity_signature: qeSig, qe_identity_issuer_chain: qeChain,
  };
}

async function dcap(label: string, quoteHex: string) {
  try {
    const q = hexToBytes(quoteHex.replace(/^0x/, ""));
    const c = await collateral(q);
    const t = performance.now();
    const r = verifyTdxQuote(q, c);
    note(`${label}: our TS DCAP parser verifies the live quote`, true, `TCB ${r.tcbStatus}${r.advisoryIds.length ? ` (${r.advisoryIds.join(",")})` : ""}, ${(performance.now() - t).toFixed(0)} ms, quote ${q.length} B, FMSPC ${collateralQuery(q).fmspc}`);
  } catch (e) {
    note(`${label}: our TS DCAP parser verifies the live quote`, false, String((e as Error).message));
  }
}

/** One 16×16 PNG of one colour, built here so no file is read or sent. */
function png(rgb: [number, number, number]): string {
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); td.copy(out, 4); out.writeUInt32BE(crc32(td), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 16 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(16).fill(rgb).flat())])));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

type Sealed = { status: number; reqBytes: string; respBytes: string; chunks: Record<string, unknown>[]; badLines: number; done: boolean; afterDone: boolean; secret: Uint8Array; clientPub: string };
async function sealedChat(model: string, body: Record<string, unknown>, enclaveKey: string, modelPubOverride?: string): Promise<Sealed> {
  const { body: sealed, headers, key } = sealRequest({ model, stream: true, stream_options: { include_usage: true }, max_tokens: 400, ...body }, enclaveKey);
  if (modelPubOverride) headers["X-Model-Pub-Key"] = modelPubOverride;
  const reqBytes = JSON.stringify(sealed);
  let r: Response, respBytes: string;
  try {
    r = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json", ...headers }, body: reqBytes, signal: AbortSignal.timeout(300_000) });
    respBytes = await r.text();
  } catch (e) { // status 0: the connection failed or was dropped
    return { status: 0, reqBytes, respBytes: mask(String((e as Error).cause ?? e)), chunks: [], badLines: 0, done: false, afterDone: false, secret: key.secret, clientPub: key.publicHex };
  }
  const chunks: Record<string, unknown>[] = []; let badLines = 0, done = false, afterDone = false;
  for (const line of respBytes.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") { done = true; continue; }
    if (done) afterDone = true;
    try { chunks.push(JSON.parse(d)); } catch { badLines++; }
  }
  return { status: r.status, reqBytes, respBytes, chunks, badLines, done, afterDone, secret: key.secret, clientPub: key.publicHex };
}

/** Checks the stream invariants §3 relies on; returns the chat id. Opened text stays in memory. */
function streamChecks(label: string, s: Sealed): string | undefined {
  if (s.status !== 200) { note(`${label}: HTTP 200`, false, `HTTP ${s.status}: ${s.respBytes.slice(0, 200)}`); return; }
  const ids = new Set(s.chunks.map((c) => c.id)), models = new Set(s.chunks.map((c) => c.model));
  const id = [...ids][0];
  note(`${label}: one chunk id and model for the whole stream`, ids.size === 1 && typeof id === "string" && models.size === 1 && s.badLines === 0, `${s.chunks.length} chunks, ${ids.size} id(s), ${models.size} model(s), ${s.badLines} unparsable data lines`);
  let plain = 0, sealedN = 0, odd = "";
  for (const c of s.chunks) {
    try { mapReplyFields(c, (v) => { if (HEXF.test(v)) sealedN++; else plain++; return v; }); } catch (e) { odd ||= String((e as Error).message); }
  }
  note(`${label}: every content field in the reply is sealed`, plain === 0 && sealedN > 0 && !odd, `${sealedN} sealed, ${plain} plaintext${odd ? `, ${odd}` : ""}`);
  let opened = 0, failed = 0, text = "";
  for (const c of s.chunks) {
    try { const o = openReply(c, s.secret); opened++; for (const ch of o.choices ?? []) text += typeof ch.delta?.content === "string" ? ch.delta.content : ""; }
    catch { failed++; }
  }
  note(`${label}: every chunk opens with our client key`, failed === 0 && opened > 0, `${opened} opened, ${failed} failed, ${text.length} chars of reply text`);
  const finishes = s.chunks.flatMap((c) => ((c.choices ?? []) as { finish_reason?: string | null }[]).map((ch) => ch.finish_reason).filter(Boolean));
  const usageChunk = [...s.chunks].reverse().find((c) => c.usage);
  const u = usageChunk?.usage as Record<string, unknown> | undefined;
  note(`${label}: usage is plaintext numbers in the last chunk`, !!u && typeof u.prompt_tokens === "number" && usageChunk === s.chunks.at(-1), u ? `prompt ${u.prompt_tokens}, completion ${u.completion_tokens}` : "no usage");
  note(`${label}: stream ends with finish_reason, usage, [DONE], nothing after`, finishes.length > 0 && !!u && s.done && !s.afterDone, `finish_reason ${finishes.join(",") || "none"}`);
  if (typeof id !== "string") { note(`${label}: chat id for the signature`, false, "no string id in the stream"); return; }
  return id;
}

async function signature(label: string, model: string, chatId: string, algo: "ed25519" | "ecdsa", s: { reqBytes: string; respBytes: string }, signer: string, clientPub?: string) {
  let sig: Record<string, unknown> = {}, status = 0;
  for (let i = 0; i < 5 && !sig.text; i++) { // the proxy may store the signature a moment after [DONE]
    if (i) await new Promise((res) => setTimeout(res, 1500));
    const r = await get(`/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=${algo}`);
    status = r.status;
    if (status === 200) sig = r.json;
  }
  if (!sig.text) return note(`${label}: signature available`, false, `last HTTP ${status}`);
  const text = String(sig.text), reqSha = bytesToHex(sha256(utf8ToBytes(s.reqBytes))), respSha = bytesToHex(sha256(utf8ToBytes(s.respBytes)));
  note(`${label}: signed text is model:sha256(req):sha256(resp) over our exact bytes`, text === `${model}:${reqSha}:${respSha}`, `${text.split(":").length} colon-separated parts`);
  if (clientPub) note(`${label}: signed text binds X-Client-Pub-Key`, null, text.toLowerCase().includes(clientPub.toLowerCase()) ? "yes" : "no: the client key is not in the signed text");
  if (algo === "ed25519") {
    let ok = false;
    try { ok = ed25519.verify(hexToBytes(String(sig.signature).replace(/^0x/, "")), utf8ToBytes(text), hexToBytes(signer)); } catch { /* ok stays false */ }
    note(`${label}: Ed25519 signature verifies against the attested signing_public_key`, ok, `signing_algo ${sig.signing_algo}, signer matches report: ${String(sig.signing_address).toLowerCase() === signer.toLowerCase()}`);
  } else {
    const v = verifySignedResponse({ text, signature: String(sig.signature) }, signer, { reqSha256: reqSha, respSha256: respSha, model });
    note(`${label}: verifySignedResponse accepts the live 3-part ECDSA signature (#93)`, v.ok, v.checks.filter((c) => !c.ok).map((c) => c.name).join(", ") || "all checks pass");
  }
}

/** Status of a POST read with node:https: undici's fetch drops a reply the server sends before it has read the body. */
function postStatus(path: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request(BASE + path, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers }, timeout: 120_000 }, (res) => {
      let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

const size = (v: unknown) => (typeof v === "string" ? v.length : JSON.stringify(v ?? "").length);

async function main() {
  console.log("N0 probe, NEAR AI Cloud E2EE v2 —", new Date().toISOString());
  const list = await get("/model/list?limit=1000");
  const models = Array.isArray(list.json.models) ? (list.json.models as { modelId: string; metadata?: { attestationSupported?: boolean } }[]) : [];
  const attested = models.filter((m) => m.metadata?.attestationSupported).map((m) => m.modelId);
  note("attested models (/model/list)", list.status === 200 && attested.length > 0 ? null : false, `HTTP ${list.status}, ${attested.length}: ${attested.join(", ")}`);
  const model = arg("model") ?? TEXT_PREFS.find((m) => attested.includes(m)) ?? attested[0];
  if (!model) return note("a text model to probe", false, "none found; remaining checks skipped");
  note("text model / vision model", null, `${model} / ${VISION}`);

  console.log("\n— Attestation (Ed25519) —");
  const rep = await report(model, "ed25519");
  const e = rep.entry;
  if (rep.status !== 200 || !e?.signing_public_key) return note("ed25519 report", false, `HTTP ${rep.status}; remaining checks skipped`);
  const pub = e.signing_public_key;
  const q = parseTdxQuote(e.intel_quote);
  note("report_data[0..32] = signing_public_key, [32..64] = our nonce", bytesToHex(q.reportData) === pub.toLowerCase() + rep.nonce, `signing_address ${e.signing_address === pub ? "equals" : "differs from"} signing_public_key`);
  note("TD debug off", !q.debug);
  await dcap("model CVM", e.intel_quote);
  const gw = rep.json.gateway_attestation as Report | undefined;
  if (gw?.intel_quote) await dcap("gateway CVM", gw.intel_quote);
  else note("gateway CVM: report has a gateway quote", false);
  const info = (e as { info?: Record<string, unknown> }).info ?? {};
  note("report size and entries", null, `${JSON.stringify(rep.json).length} B in ${rep.ms.toFixed(0)} ms, ${rep.all.length} model_attestations entr${rep.all.length === 1 ? "y" : "ies"}; nvidia_payload ${size(e.nvidia_payload)} B, model app_cert ${size(info.app_cert)} B, model tcb_info ${size(info.tcb_info)} B, gateway_attestation ${size(rep.json.gateway_attestation)} B`);

  console.log("\n— GPU evidence binding —");
  try {
    const p = JSON.parse(e.nvidia_payload ?? "") as { nonce?: string; arch?: string; evidence_list?: { nonce?: string }[] };
    const ev = Array.isArray(p.evidence_list) ? p.evidence_list : [];
    note("nvidia_payload nonce = our request nonce, top level and on every GPU entry", p.nonce === rep.nonce && ev.length > 0 && ev.every((x) => x.nonce === rep.nonce), `${ev.length} × ${p.arch}`);
    const gpuHash = bytesToHex(sha256(utf8ToBytes(e.nvidia_payload ?? "")));
    note("sha256(nvidia_payload) appears in the CVM quote", null, e.intel_quote.toLowerCase().includes(gpuHash) ? "yes" : "no (and report_data is key ‖ nonce, checked above)");
  } catch { note("nvidia_payload parses", false); }

  console.log("\n— Backends per model —");
  for (const m of [...new Set([model, VISION, ...attested])]) {
    const keys = new Set<string>(), statuses = new Set<number>(), formats = new Set<string>(); let maxEntries = 0, ok = 0, err = "", same = true;
    for (let i = 0; i < REPORTS; i++) {
      const r = await report(m, "ed25519");
      statuses.add(r.status);
      if (r.status !== 200) { err ||= JSON.stringify((r.json.error as { message?: string })?.message ?? r.json).slice(0, 200); continue; }
      ok++;
      maxEntries = Math.max(maxEntries, r.all.length);
      // NEAR-format entries carry model_name + signing_public_key; others (Chutes, Tinfoil) name their provider instead.
      for (const a of r.all) formats.add(a.provider ? `${a.provider}${a.trust ? ` (${a.trust})` : ""}` : a.signing_public_key ? "near ed25519" : "unknown");
      for (const a of r.all) if ((a.model_name === m || (r.all.length === 1 && !a.model_name)) && a.signing_public_key) { keys.add(a.signing_public_key); same &&= a.signing_public_key === a.signing_address; }
    }
    note(`${m}: distinct signing keys`, null, `${keys.size} key(s) over ${ok}/${REPORTS} good reports, up to ${maxEntries} entr${maxEntries === 1 ? "y" : "ies"} per report, format ${[...formats].join("+") || "none"}, key = signing_address: ${keys.size ? same : "n/a"}, HTTP ${[...statuses].join(",")}${err ? `, error: ${err}` : ""}`);
  }
  const sw = sealRequest({ model, max_tokens: 10, messages: [{ role: "user", content: "Reply with the single word: ok" }] }, pub);
  const wrong = await postStatus("/chat/completions", JSON.stringify(sw.body), { ...sw.headers, "X-Model-Pub-Key": nearKey().publicHex });
  note("X-Model-Pub-Key for an unknown backend is refused as a key error, not served", wrong.status === 421 && /encryption key/i.test(wrong.body), `HTTP ${wrong.status}: ${wrong.body.slice(0, 160)}`);

  console.log("\n— Sealed text chat —");
  const t = await sealedChat(model, { messages: [{ role: "user", content: "Reply with the single word: ok" }] }, pub);
  const tid = streamChecks("text", t);
  if (tid) await signature("text", model, tid, "ed25519", t, pub, t.clientPub);

  console.log("\n— Sealed image chat —");
  const vrep = await report(VISION, "ed25519");
  const vpub = vrep.entry?.signing_public_key;
  if (vpub) {
    for (const [name, rgb, other] of [["red", [255, 0, 0], "blue"], ["blue", [0, 0, 255], "red"]] as const) {
      const img = await sealedChat(VISION, { messages: [{ role: "user", content: [{ type: "text", text: "What colour is this image? One word." }, { type: "image_url", image_url: { url: png([...rgb]) } }] }], max_tokens: 1500 }, vpub);
      const sent = JSON.parse(img.reqBytes) as { messages: { content: unknown }[] };
      note(`image ${name}: the content-parts array goes as one sealed string`, typeof sent.messages[0].content === "string" && HEXF.test(sent.messages[0].content as string));
      const iid = streamChecks(`image ${name}`, img);
      const said = img.chunks.map((c) => { try { return openReply(c, img.secret).choices?.map((ch) => (typeof ch.delta?.content === "string" ? ch.delta.content : "")).join("") ?? ""; } catch { return ""; } }).join("");
      note(`image ${name}: the answer names ${name} and not ${other}`, new RegExp(`\\b${name}\\b`, "i").test(said) && !new RegExp(`\\b${other}\\b`, "i").test(said));
      if (iid) await signature(`image ${name}`, VISION, iid, "ed25519", img, vpub);
    }
  } else note("vision model report", false, `HTTP ${vrep.status}`);

  console.log("\n— In-enclave web search under E2EE —");
  const w = await sealedChat(model, { messages: [{ role: "user", content: "Use web search once for the query 'example.com domain' and then reply with the single word: done" }], tools: [NEAR_SEARCH_TOOL], max_tokens: 800 }, pub);
  const wid = streamChecks("search", w);
  let args = 0, results = 0, sealedArgs = 0, sealedOut = 0;
  for (const c of w.chunks) for (const ch of (c.choices ?? []) as { delta?: { tool_calls?: { function?: { arguments?: string } }[]; nearai_tool_result?: { output?: string } } }[]) {
    for (const tc of ch.delta?.tool_calls ?? []) if (tc.function?.arguments) { args++; if (HEXF.test(tc.function.arguments)) sealedArgs++; }
    if (ch.delta?.nearai_tool_result) { results++; if (HEXF.test(ch.delta.nearai_tool_result.output ?? "")) sealedOut++; }
  }
  note("search: tool-call arguments and results come back sealed", args > 0 && results > 0 && sealedArgs === args && sealedOut === results, `${args} non-empty argument deltas (${sealedArgs} sealed), ${results} results (${sealedOut} sealed)`);
  if (wid) await signature("search", model, wid, "ed25519", w, pub);

  console.log("\n— Forgery with only X-Client-Pub-Key —");
  try {
    const victim = nearKey();
    const opens = openField(sealField("forged", victim.publicHex), victim.secret) === "forged";
    note("anyone holding X-Client-Pub-Key can seal reply fields that open", null, opens ? "yes: decryption proves nothing about the sender; only the reply signature does" : "no");
  } catch (err) { note("forgery self-test runs", false, String((err as Error).message)); }

  console.log("\n— ECDSA path, plaintext (#93) —");
  const er = await report(model, "ecdsa");
  if (er.entry) {
    const body = JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 20 });
    let id: string | undefined, respBytes = "", status = 0;
    try {
      const r = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(120_000) });
      status = r.status; respBytes = await r.text();
      id = (JSON.parse(respBytes) as { id?: string }).id;
    } catch { /* noted below */ }
    if (status === 200 && typeof id === "string") await signature("ecdsa", model, id, "ecdsa", { reqBytes: body, respBytes }, er.entry.signing_address);
    else note("ecdsa chat", false, `HTTP ${status}`);
  } else note("ecdsa report", false, `HTTP ${er.status}`);

  const failed = rows.filter((r) => r.ok === false);
  console.log(`\n${rows.filter((r) => r.ok).length} passed, ${failed.length} failed, ${rows.filter((r) => r.ok === null).length} observations`);
}

main().catch((e) => { console.error(mask(String(e?.stack ?? e))); process.exitCode = 2; });
