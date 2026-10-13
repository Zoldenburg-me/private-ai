/** Parse OpenAI-style SSE chunks into text deltas. */
export function parseSseChunk(buffer: string): { deltas: string[]; rest: string; done: boolean } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const deltas: string[] = [];
  let done = false;
  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const data = l.slice(5).trim();
    if (data === "[DONE]") { done = true; continue; }
    try { const d = JSON.parse(data)?.choices?.[0]?.delta?.content; if (d) deltas.push(d); } catch { /* partial */ }
  }
  return { deltas, rest, done };
}
