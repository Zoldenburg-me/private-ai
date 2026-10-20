export interface Receipt { chat_id: string; provider: string; model: string; req_sha256: string; resp_sha256: string }
/** One agent tool step, as /api/agent streams it in `event: agent_tool` (same id: running, then done or error). */
export interface ToolEvent { id: string; name: string; status: "running" | "done" | "error"; query?: string; results?: { title: string; url: string }[] }

/** Parse OpenAI-style SSE chunks into text deltas; also picks up our `pai_receipt` and `agent_tool` events. */
export function parseSseChunk(buffer: string): { deltas: string[]; rest: string; done: boolean; receipt?: Receipt; tools: ToolEvent[]; error?: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const deltas: string[] = []; const tools: ToolEvent[] = [];
  let done = false; let receipt: Receipt | undefined; let event = ""; let error: string | undefined;
  for (const line of lines) {
    const l = line.trim();
    if (l === "") { event = ""; continue; }
    if (l.startsWith("event:")) { event = l.slice(6).trim(); continue; }
    if (!l.startsWith("data:")) continue;
    const data = l.slice(5).trim();
    if (event === "pai_receipt") { try { receipt = JSON.parse(data) as Receipt; } catch { /* ignore */ } continue; }
    if (event === "agent_error") { try { error = String((JSON.parse(data) as { message?: unknown }).message ?? "agent run failed"); } catch { error = "agent run failed"; } continue; }
    if (event === "agent_tool") { try { tools.push(JSON.parse(data) as ToolEvent); } catch { /* ignore */ } continue; }
    if (data === "[DONE]") { done = true; continue; }
    try { const d = JSON.parse(data)?.choices?.[0]?.delta?.content; if (d) deltas.push(d); } catch { /* partial */ }
  }
  return { deltas, rest, done, receipt, tools, error };
}
