/**
 * Keeps a streaming reply inside the chat it was started in. Every switch (new chat, ghost
 * toggle, opening another chat, wipe) starts a new scope and aborts the running stream, so a
 * ghost reply can never land in, or be saved with, a normal chat (and vice versa).
 */
export interface ChatTurn { signal: AbortSignal; current(): boolean }

export class ChatScope {
  private generation = 0;
  private controllers: AbortController[] = [];

  switch(): void {
    this.generation++;
    for (const c of this.controllers) c.abort();
    this.controllers = [];
  }

  begin(): ChatTurn {
    const mine = this.generation;
    const controller = new AbortController();
    this.controllers = [...this.controllers, controller];
    return { signal: controller.signal, current: () => this.generation === mine };
  }
}
