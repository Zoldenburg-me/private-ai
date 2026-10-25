/** One synthetic eval question and whether a good agent should search for it. */
export interface EvalCase { id: string; expect: "search" | "no_search"; prompt: string }
/** What one /api/agent run did, as the runner saw it on the stream. */
export interface EvalRun { searched: boolean; text: string; error?: string; ms: number }
export type Failure = "no_answer" | "missed_search" | "needless_search" | "uncited";

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
