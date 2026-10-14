import { describe, it, expect } from "vitest";
import { ChatScope } from "../lib/chat-scope";

describe("ChatScope: a reply only lands in the chat it was started in", () => {
  it("a switch (new chat, ghost toggle, open chat) drops later updates and aborts the stream", () => {
    const scope = new ChatScope();
    const turn = scope.begin();
    expect(turn.current()).toBe(true);
    scope.switch();
    expect(turn.current()).toBe(false);
    expect(turn.signal.aborted).toBe(true);
    const next = scope.begin();
    expect(next.current()).toBe(true);
    expect(next.signal.aborted).toBe(false);
  });
  it("starting a new turn does not cancel the scope of the previous one", () => {
    const scope = new ChatScope();
    const a = scope.begin(); const b = scope.begin();
    expect(a.current()).toBe(true);
    expect(b.current()).toBe(true);
  });
});
