/**
 * Keeps a streaming reply inside the chat it was started in. Every switch (new chat, ghost
 * toggle, opening another chat, wipe) starts a new scope and aborts the running stream, so a
 * ghost reply can never land in, or be saved with, a normal chat (and vice versa).
 * A switch keeps the partial reply; forget()/discardAll() (delete, wipe) also stop it from being saved.
 */
export interface ChatTurn { signal: AbortSignal; current(): boolean; discarded(): boolean; end(): void }

interface Live { chatId: string; controller: AbortController; discarded: boolean }

export class ChatScope {
  private generation = 0;
  private live = new Set<Live>();

  switch(): void {
    this.generation++;
    for (const t of this.live) t.controller.abort();
  }

  /** The chat was deleted: its turns (running or still finishing after an abort) must not save it again. */
  forget(chatId: string): void {
    for (const t of this.live) if (t.chatId === chatId) { t.discarded = true; t.controller.abort(); }
  }

  /** Everything was wiped: abort every turn and drop whatever it would still save. */
  discardAll(): void {
    for (const t of this.live) t.discarded = true;
    this.switch();
  }

  begin(chatId = ""): ChatTurn {
    const mine = this.generation;
    const t: Live = { chatId, controller: new AbortController(), discarded: false };
    this.live.add(t);
    return {
      signal: t.controller.signal,
      current: () => this.generation === mine,
      discarded: () => t.discarded,
      end: () => { this.live.delete(t); },
    };
  }
}
