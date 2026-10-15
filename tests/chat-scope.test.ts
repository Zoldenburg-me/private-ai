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

describe("ChatScope: deleted or wiped chats are not saved again", () => {
  it("a plain switch keeps the partial reply saveable", () => {
    const scope = new ChatScope();
    const turn = scope.begin("a");
    scope.switch();
    expect(turn.signal.aborted).toBe(true);
    expect(turn.discarded()).toBe(false);
  });
  it("forget(chatId) discards and aborts only that chat's turns, including ones still finishing after a switch", () => {
    const scope = new ChatScope();
    const a = scope.begin("a"); const b = scope.begin("b");
    scope.switch(); // a's abort handler has not saved yet
    scope.forget("a");
    expect(a.discarded()).toBe(true);
    expect(b.discarded()).toBe(false);
    const c = scope.begin("c");
    scope.forget("c");
    expect(c.signal.aborted).toBe(true);
    expect(c.current()).toBe(true);
  });
  it("discardAll() discards and aborts every live turn; ended turns and later turns are unaffected", () => {
    const scope = new ChatScope();
    const done = scope.begin("x"); done.end();
    const a = scope.begin("a"); const b = scope.begin("b");
    scope.discardAll();
    expect([a, b].every((t) => t.discarded() && t.signal.aborted)).toBe(true);
    expect(done.discarded()).toBe(false);
    expect(scope.begin("n").discarded()).toBe(false);
  });
});
