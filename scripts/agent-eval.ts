/**
 * Synthetic eval for /api/agent: does each model search when it should, skip it when it should not, answer and cite?
 * Only fixed test questions from evals/agent-cases.json are sent; replies are scored in memory, never printed or stored.
 *   npx vite-node scripts/agent-eval.ts [--models near:a,tinfoil:b] [--cases id1,id2] [--json]
 * Env: EVAL_BASE_URL (default http://127.0.0.1:3000), EVAL_TOKEN (default: a fresh anonymous session, Free tier).
 * Free allows 20 messages a day and 5 a minute, each agent step counting; for a full run give the token's account
 * a paid tier on a dev server: ENTITLEMENTS='{"<account id>":"max"}' (the id is printed below).
 */
import { readFileSync } from "node:fs";
import { parseSseChunk } from "../lib/sse";
import { score, skipped, type EvalCase, type EvalRun, type Failure } from "../evals/score";

const BASE = process.env.EVAL_BASE_URL ?? "http://127.0.0.1:3000";
const CASE_TIMEOUT_MS = 180_000;
/** Our gate's refusals that hold for the rest of the day: every later case would fail the same way. */
const STOP = /daily limit reached|error budget exceeded/;
const SLOW_DOWN = /rate limit, slow down/;
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const list = (s: string | undefined) => s?.split(",").map((x) => x.trim()).filter(Boolean);

async function token(): Promise<string> {
  if (process.env.EVAL_TOKEN) return process.env.EVAL_TOKEN;
  const s = await (await fetch(`${BASE}/api/session`)).json() as { apiToken?: string; features?: { webSearch?: boolean } };
  if (!s.apiToken) throw new Error("no apiToken from /api/session");
  if (!s.features?.webSearch) throw new Error("agent mode is off on this server (no search key, or invite gate without an account)");
  console.error(`anonymous session, account id ${s.apiToken.slice(4).split(".")[0]} (Free tier)`);
  return s.apiToken;
}

async function run(tok: string, model: string, c: EvalCase): Promise<EvalRun> {
  const t = Date.now();
  let text = ""; let searched = false; let error: string | undefined; let finished = false;
  try {
    const res = await fetch(`${BASE}/api/agent`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(CASE_TIMEOUT_MS),
      body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: c.prompt }], pai_options: { web_search: true } }),
    });
    if (!res.ok || !res.body) return { searched, text, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, ms: Date.now() - t };
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = "";
    const take = (chunk: string) => {
      const p = parseSseChunk(chunk);
      buf = p.rest; text += p.deltas.join("");
      if (p.tools.some((e) => e.name !== "generate_image")) searched = true; // any search attempt, ours or the provider's
      if (p.error) error = p.error;
      finished ||= p.done;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      take(buf + dec.decode(value, { stream: true }));
    }
    take(buf + "\n"); // an event without a trailing newline
    // /api/agent ends every answer with [DONE] or agent_error: anything else is a cut connection, not an answer.
    if (!finished && !error) error = "connection lost before [DONE]";
  } catch (e) {
    error = `request failed: ${(e as Error).message}`; // a timeout or a dropped connection fails this case, not the whole run
  }
  return { searched, text, error, ms: Date.now() - t };
}

const all = JSON.parse(readFileSync(new URL("../evals/agent-cases.json", import.meta.url), "utf8")) as EvalCase[];
const only = list(arg("cases"));
const cases = only ? all.filter((c) => only.includes(c.id)) : all;
const tok = await token();
const models = list(arg("models")) ?? ((await (await fetch(`${BASE}/api/v1/models`)).json()) as { data: { id: string }[] }).data.map((m) => m.id);
/** What --json prints: scores only, no reply text. */
const results: { model: string; id: string; failures: Failure[]; searched: boolean; answerChars: number; ms: number }[] = [];

for (const model of models) {
  const fails: Partial<Record<Failure, string[]>> = {};
  let passed = 0; const ms: number[] = []; const skips: Record<string, string[]> = {};
  for (const c of cases) {
    let r = await run(tok, model, c);
    if (SLOW_DOWN.test(r.error ?? "")) { await new Promise((res) => setTimeout(res, 61_000)); r = await run(tok, model, c); } // the per-minute window
    if (STOP.test(r.error ?? "")) { (skips[r.error!.slice(0, 80)] ??= []).push(c.id); console.error(`${model}: stopped, ${r.error}`); break; }
    // An access refusal or provider failure says nothing about the model: list it, never score it.
    if (skipped(r)) { (skips[r.error!.slice(0, 80)] ??= []).push(c.id); continue; }
    const failures = score(c, r);
    results.push({ model, id: c.id, failures, searched: r.searched, answerChars: r.text.length, ms: r.ms });
    ms.push(r.ms);
    if (!failures.length) passed++;
    for (const f of failures) (fails[f] ??= []).push(c.id);
  }
  const median = ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? 0;
  const skippedN = Object.values(skips).flat().length;
  const ran = ms.length + skippedN;
  console.log(`${model}  ${passed}/${ms.length} passed${skippedN ? `, ${skippedN} skipped` : ""}${ran < cases.length ? ` (stopped after ${ran} of ${cases.length})` : ""}  median ${(median / 1000).toFixed(1)}s` +
    Object.entries(fails).map(([f, ids]) => `\n  ${f}: ${ids!.join(", ")}`).join("") +
    Object.entries(skips).map(([e, ids]) => `\n  skipped (${e}): ${ids.join(", ")}`).join(""));
}
if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
