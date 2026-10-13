export interface Receipt { chat_id: string; provider: string; model: string; req_sha256: string; resp_sha256: string }

/** Parse OpenAI-style SSE chunks into text deltas; also picks up our `pai_receipt` event. */
export function parseSseChunk(buffer: string): { deltas: string[]; rest: string; done: boolean; receipt?: Receipt } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const deltas: string[] = [];
  let done = false; let receipt: Receipt | undefined; let event = "";
  for (const line of lines) {
    const l = line.trim();
    if (l === "") { event = ""; continue; }
    if (l.startsWith("event:")) { event = l.slice(6).trim(); continue; }
    if (!l.startsWith("data:")) continue;
    const data = l.slice(5).trim();
    if (event === "pai_receipt") { try { receipt = JSON.parse(data) as Receipt; } catch { /* ignore */ } continue; }
    if (data === "[DONE]") { done = true; continue; }
    try { const d = JSON.parse(data)?.choices?.[0]?.delta?.content; if (d) deltas.push(d); } catch { /* partial */ }
  }
  return { deltas, rest, done, receipt };
}
