/** One synthetic eval question and whether a good agent should search for it. */
export interface EvalCase { id: string; expect: "search" | "no_search"; prompt: string }
/** What one /api/agent run did, as the runner saw it on the stream. */
export interface EvalRun { searched: boolean; text: string; error?: string; ms: number }
export type Failure = "no_answer" | "missed_search" | "needless_search" | "uncited";

/**
 * Errors that say nothing about the model: an access refusal (HTTP 401/403 before the stream), our gate, a provider
 * or transport failure, a cut stream. Such runs are skipped, not scored. "model did not answer" is the model's own failure.
 */
const SKIP = /^(HTTP \d|request failed|connection lost|provider (error|unreachable|timeout|stream ended early)|agent run failed|service temporarily unavailable|daily limit|rate limit|error budget)/;
export const skipped = (r: EvalRun) => !!r.error && SKIP.test(r.error);

/** Every check a run fails; empty means it passed. Citations only count for an answer to a case that needed a search that ran. */
export function score(c: EvalCase, r: EvalRun): Failure[] {
  const f: Failure[] = [];
  const answered = !r.error && !!r.text.trim();
  if (!answered) f.push("no_answer");
  if (c.expect === "search" && !r.searched) f.push("missed_search");
  if (c.expect === "no_search" && r.searched) f.push("needless_search");
  if (answered && c.expect === "search" && r.searched && !/\]\(https?:\/\//.test(r.text)) f.push("uncited");
  return f;
}
