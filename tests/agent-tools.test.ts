import { describe, it, expect, afterEach } from "vitest";
import { TOOLS, firstStepBody, runAgent } from "../lib/agent";
import { parseSseChunk } from "../lib/sse";

const enc = new TextEncoder();
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(c) {
  for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
} }));
const callStream = (name: string) => sse([{ id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: `{"text":"hi"}` } }] }, finish_reason: "tool_calls" }] }]);
const answerStream = () => sse([{ id: "c2", choices: [{ delta: { content: "Done" } }] }, { id: "c2", choices: [{ delta: {}, finish_reason: "stop" }] }]);
const provider = { id: "mock", name: "Mock", privacy: "tee-attested" as const, baseUrl: "http://upstream/v1", apiKey: "k", defaultModel: "" };

/** Runs the agent against a model that calls `name` once, then answers; returns the model bodies and the client events. */
async function run(name: string) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? callStream(name) : answerStream();
  }) as unknown as typeof fetch;
  const res = runAgent({ provider, body: { model: "m", messages: [{ role: "user", content: "q" }] }, maxSteps: 3, beforeStep: async () => null,
    env: { MOCK_PROVIDER: "1" }, log: () => {}, route: "/api/agent", fetchImpl });
  const out = parseSseChunk((await res.text()) + "\n");
  const toolMsg = (bodies[1].messages as { role: string; content: string }[]).at(-1)!;
  return { bodies, out, toolMsg };
}

afterEach(() => { TOOLS.delete("echo"); });

describe("agent tool map", () => {
  it("an unknown tool name gets the fixed error", async () => {
    const { out, toolMsg } = await run("no_such_tool");
    expect(toolMsg).toMatchObject({ role: "tool", content: "error: unknown tool no_such_tool" });
    expect(out.tools.map((t) => t.status)).toEqual(["running", "error"]);
    expect(out.deltas.join("")).toBe("Done");
  });

  it("a second tool in the map is offered and dispatched", async () => {
    const def = { type: "function" as const, function: { name: "echo", description: "Echo text.", parameters: { type: "object", properties: { text: { type: "string" } } } } };
    TOOLS.set("echo", { def, maxPerRun: 1, available: () => true, shown: () => ({}), errors: { args: "e", cap: "e", failed: "e" },
      run: async (args) => ({ forModel: `echo:${(JSON.parse(args) as { text: string }).text}` }) });
    const { bodies, out, toolMsg } = await run("echo");
    expect((bodies[0].tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(["web_search", "echo"]);
    // The first rate-limit estimate counts the same tools the first request sends.
    expect(firstStepBody({ model: "m", messages: [{ role: "user", content: "q" }] }, 3, { provider, env: { MOCK_PROVIDER: "1" } }).tools).toEqual(bodies[0].tools);
    expect(toolMsg).toMatchObject({ role: "tool", content: "echo:hi" });
    expect(out.deltas.join("")).toBe("Done");
    expect(out.tools.map((t) => [t.name, t.status])).toEqual([["echo", "running"], ["echo", "done"]]);
  });
});
