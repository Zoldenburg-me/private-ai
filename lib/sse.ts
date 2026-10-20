export interface Receipt { chat_id: string; provider: string; model: string; req_sha256: string; resp_sha256: string }
/** One agent tool step, as /api/agent streams it in `event: agent_tool` (same id: running, then done or error). */
export interface ToolEvent { id: string; name: string; status: "running" | "done" | "error"; query?: string; results?: { title: string; url: string }[] }

const isToolEvent = (v: unknown): v is ToolEvent => typeof v === "object" && v !== null &&
  typeof (v as ToolEvent).id === "string" && typeof (v as ToolEvent).name === "string" && ["running", "done", "error"].includes((v as ToolEvent).status);

/**
 * Parse OpenAI-style SSE chunks into text deltas; also picks up our `pai_receipt`, `agent_tool` and `agent_error`
 * events. An `event:` line whose `data:` line has not arrived yet stays in `rest`, so a read that splits them loses nothing.
 */
export function parseSseChunk(buffer: string): { deltas: string[]; rest: string; done: boolean; receipt?: Receipt; tools: ToolEvent[]; error?: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const deltas: string[] = []; const tools: ToolEvent[] = [];
  let done = false; let receipt: Receipt | undefined; let event = ""; let error: string | undefined;
  let pending = ""; // the event line, until its data line is seen
  for (const line of lines) {
    const l = line.trim();
    if (l === "") { event = ""; pending = ""; continue; }
    if (l.startsWith("event:")) { event = l.slice(6).trim(); pending = line; continue; }
    if (!l.startsWith("data:")) continue;
    pending = "";
    const data = l.slice(5).trim();
    if (event === "pai_receipt") { try { receipt = JSON.parse(data) as Receipt; } catch { /* ignore */ } continue; }
    if (event === "agent_error") { try { error = String((JSON.parse(data) as { message?: unknown }).message ?? "agent run failed"); } catch { error = "agent run failed"; } continue; }
    if (event === "agent_tool") { try { const t: unknown = JSON.parse(data); if (isToolEvent(t)) tools.push(t); } catch { /* ignore */ } continue; }
    if (data === "[DONE]") { done = true; continue; }
    try { const d = JSON.parse(data)?.choices?.[0]?.delta?.content; if (d) deltas.push(d); } catch { /* partial */ }
  }
  return { deltas, rest: pending ? `${pending}\n${rest}` : rest, done, receipt, tools, error };
}
