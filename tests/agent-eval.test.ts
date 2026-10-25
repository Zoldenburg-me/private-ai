import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { score, type EvalCase } from "@/evals/score";

const search: EvalCase = { id: "s", expect: "search", prompt: "news today" };
const plain: EvalCase = { id: "p", expect: "no_search", prompt: "2+2" };
const run = (o: Partial<{ searched: boolean; text: string; error: string }>) => ({ searched: false, text: "ok", ms: 1, ...o });

describe("agent eval scoring", () => {
  it("passes a cited search and a plain answer", () => {
    expect(score(search, run({ searched: true, text: "See [x](https://example.org)." }))).toEqual([]);
    expect(score(plain, run({ text: "4" }))).toEqual([]);
  });
  it("flags a missed or needless search", () => {
    expect(score(search, run({}))).toEqual(["missed_search"]);
    expect(score(plain, run({ searched: true }))).toEqual(["needless_search"]);
  });
  it("flags a search answer without a link", () => {
    expect(score(search, run({ searched: true, text: "It is sunny." }))).toEqual(["uncited"]);
  });
  it("flags an empty answer or an error", () => {
    expect(score(plain, run({ text: " " }))).toEqual(["no_answer"]);
    expect(score(plain, run({ error: "provider timeout" }))).toEqual(["no_answer"]);
    expect(score(search, run({ searched: true, text: "" }))).toEqual(["no_answer"]); // not also "uncited"
  });
  it("ships well-formed cases with unique ids and both expectations", () => {
    const cases = JSON.parse(readFileSync("evals/agent-cases.json", "utf8")) as EvalCase[];
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.every((c) => ["search", "no_search"].includes(c.expect) && c.prompt.trim())).toBe(true);
    expect(new Set(cases.map((c) => c.expect)).size).toBe(2);
  });
});
