"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive, useLocalRuntime,
  type ChatModelAdapter, type ChatModelRunResult, type ThreadMessageLike,
} from "@assistant-ui/react";
import { ArrowCounterClockwise, ArrowUp, CheckCircle, Copy, EyeSlash, Lightbulb, MagnifyingGlass, MinusCircle, Paperclip, Stop, XCircle } from "@phosphor-icons/react";
import { SafeMarkdown } from "@/components/markdown";
import { ProviderFailure, normalizeIncognito, streamChat, toChatMessages, toStoredMessages, type Incognito, type StoredMsg } from "@/lib/client/chat-stream";
import { normalizeSigned, type Signed } from "@/lib/client/proof";
import type { Receipt, ToolEvent } from "@/lib/sse";
import { publicHttpUrl } from "@/lib/web-search";
import type { Chat } from "@/lib/storage";
import type { Persona } from "@/lib/personas";
import type { ChatScope } from "@/lib/chat-scope";
import { ANONYMIZED_NOTE, GATEWAY_ONLY, PROVIDER_LABEL } from "@/lib/client/providers";

/** Names the provider this chat is actually sent to (Auto picks it per proof), or none while Auto is still choosing. */
export function enclaveLine(modelRef: string): string {
  const p = modelRef.split(":")[0];
  if (GATEWAY_ONLY.has(p)) return `Runs behind ${PROVIDER_LABEL[p] ?? p}'s attested gateway; the model itself is not attested.`;
  return p ? `Runs inside an attested enclave on ${PROVIDER_LABEL[p] ?? p}.` : "Runs inside an attested enclave.";
}

export type { Signed, StoredMsg };

export interface ThreadProps {
  chat: Chat;
  modelRef: string;
  persona?: Persona;
  ghost: boolean;
  /** isCurrent=false: the user switched chats mid-stream; persist, but do not show. */
  onSaved: (chat: Chat, ghost: boolean, isCurrent: boolean) => void;
  scope: ChatScope;
  onUsage: (remaining: string | null, limit?: string | null, quota?: string | null) => void;
  verifySignature: (r: Receipt, modelRef: string) => Promise<Signed>;
  suggestions?: string[];
  /** The selected model is anonymized: no enclave, so the welcome text must not claim one. */
  anonymized?: boolean;
  /** Homepage hand-off: send this prompt as the first message, or only put it in the composer. */
  handoff?: { text: string; send: boolean } | null;
  onHandoff?: () => void;
  /** The provider behind `modelRef` failed this turn (e.g. so Auto can move to its next route). */
  onProviderFailure: (modelRef: string) => void;
  /** Small line under the composer (e.g. the sign-up hint for signed-out visitors). */
  hint?: ReactNode;
  /** Controls placed in the composer toolbar: the ghost toggle (left) and the model picker (right). */
  ghostToggle?: ReactNode;
  modelSlot?: ReactNode;
  /** Opens the enclave proof sheet (from a reply's signature line). */
  onOpenProof?: () => void;
  /** The selected model's incognito route (no enclave), recorded on each reply it sends so the reply keeps its own label. */
  incognito?: Incognito;
  /** Send through /api/agent: the model may search the web. A standing line under the composer says so. */
  webSearch?: boolean;
  /** The composer's "+" tools menu; without one the design's "coming soon" icons show. */
  toolsSlot?: ReactNode;
}

/** The design's greeting: by time of day, or the ghost-chat warning. */
export function greeting(hour: number, ghost: boolean): [string, string] {
  if (ghost) return ["Nothing here", "will be saved."];
  return [hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.", "What's on your mind?"];
}

function textOf(content: readonly { type: string; text?: string }[]) {
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

/** The real host, shown next to the page-chosen title so a title cannot pass for another site. */
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };

/** Agent tool steps above a reply: what was searched and which pages came back (links only, nothing loads). */
function ToolSteps({ tools }: { tools: ToolEvent[] }) {
  return (
    <details className="tool-steps" data-testid="tool-steps">
      <summary>{tools.some((t) => t.status === "running") ? "Searching the web…" : `Searched the web (${tools.length})`}</summary>
      <ul>
        {tools.map((t) => (
          <li key={t.id} data-status={t.status}>
            <span className="tool-query"><MagnifyingGlass aria-hidden /> {t.query ?? t.name}{t.status === "error" && " · failed"}</span>
            {t.results && t.results.length > 0 && (
              <ul>{t.results.filter((r) => publicHttpUrl(r.url)).map((r, i) => (
                <li key={`${i}:${r.url}`}><a href={r.url} target="_blank" rel="noopener noreferrer nofollow">{r.title || r.url}<span className="sr-only"> (opens in a new tab)</span></a> <span>· {hostOf(r.url)}</span></li>
              ))}</ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export const SIG = {
  enclave: { cls: "ok", Icon: CheckCircle, text: "Signed in the enclave", testid: "signed" },
  "key-match": { cls: "warn", Icon: CheckCircle, text: "Signature matches the enclave's reported key · chain not verified", testid: "signed-key-match" },
  fail: { cls: "bad", Icon: XCircle, text: "Signature mismatch", testid: "signed-fail" },
  server: { cls: "muted", Icon: MinusCircle, text: "No per-reply signature from this provider · enclave checked by our server", testid: "signed-server" },
  gateway: { cls: "muted", Icon: MinusCircle, text: "No model-enclave signature · only the provider's gateway is attested", testid: "signed-gateway" },
  "n/a": { cls: "muted", Icon: MinusCircle, text: "No signature could be checked for this reply", testid: "signed-na" },
} as const;

/** What an assistant bubble shows. Try again only on the last reply: retrying an older one would save over the later messages. */
export function replyView(content: string, running: boolean, isLast: boolean) {
  const done = !running;
  return { body: content ? "text" : running ? "writing" : "empty", copy: done && !!content, retry: done && isLast, sig: done && !!content } as const;
}

/** The history to store after a turn. An empty reply stores no assistant message, but the submitted prompt is kept. */
export function turnToStore(stored: StoredMsg[], text: string, signed?: Signed, incognito?: Incognito): StoredMsg[] {
  return text ? [...stored, { role: "assistant", content: text, ...(signed ? { signed } : {}), ...(incognito ? { incognito } : {}) }] : stored;
}

/** The design's incognito label for a reply without a signature, from the route that reply used (none if unknown). */
export const incognitoLine = (incognito: Incognito | undefined) =>
  incognito === "private" ? "Incognito · zero-retention" : incognito === "anonymized" ? "Incognito · anonymized" : undefined;

function Message({ role, content, signed, tools, running, isLast, onOpenProof, incognito }: { role: string; content: string; signed?: Signed; tools?: ToolEvent[]; running: boolean; isLast: boolean; onOpenProof?: () => void; incognito?: Incognito }) {
  const sig = signed ? SIG[signed] : undefined;
  const line = incognitoLine(incognito);
  const view = replyView(content, running, isLast);
  return (
    <div className={`msg msg-${role}`} data-testid={`msg-${role}`}>
      <div className="bubble">
        <span className="sr-only">{role === "user" ? "You said:" : "Assistant:"}</span>
        {tools && tools.length > 0 && <ToolSteps tools={tools} />}
        {role === "assistant"
          ? view.body === "text" ? <div className="md"><SafeMarkdown text={content} /></div> : view.body === "writing" ? <p className="writing">Writing…</p> : <p className="writing" data-testid="no-reply">No reply received</p>
          : <span className="pre">{content}</span>}
        {role === "assistant" && (view.copy || view.retry) && (
          <div className="msg-actions">
            {view.copy && <ActionBarPrimitive.Copy className="icon-btn" title="Copy" aria-label="Copy"><Copy weight="duotone" aria-hidden /></ActionBarPrimitive.Copy>}
            {view.retry && <ActionBarPrimitive.Reload className="icon-btn" title="Try again" aria-label="Try again"><ArrowCounterClockwise weight="duotone" aria-hidden /></ActionBarPrimitive.Reload>}
            {view.sig && sig && <button type="button" className={`sig ${sig.cls}`} data-testid={sig.testid} onClick={onOpenProof}><sig.Icon weight="duotone" aria-hidden />{sig.text}</button>}
            {view.sig && !sig && line && <button type="button" className="sig muted" data-testid="sig-incognito" onClick={onOpenProof}><EyeSlash weight="duotone" aria-hidden />{line}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

/** A control the design shows that has no backend yet: a quiet icon that says "Coming soon" only when clicked. */
function Soon({ icon, label }: { icon: ReactNode; label: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { if (!shown) return; const t = setTimeout(() => setShown(false), 2000); return () => clearTimeout(t); }, [shown]);
  return (
    <span className="soon-wrap">
      <button type="button" className="tool-toggle soon" aria-disabled="true" aria-label={`${label} (coming soon)`} title={label} onClick={() => setShown(true)}>{icon}</button>
      {shown && <span className="soon-pop" role="status">Coming soon</span>}
    </span>
  );
}

/** One conversation, rendered with assistant-ui primitives on a LocalRuntime backed by /api/chat. */
export function ChatThread(props: ThreadProps) {
  const ref = useRef(props); ref.current = props;

  const adapter = useMemo<ChatModelAdapter>(() => ({
    async *run({ messages, abortSignal }) {
      const p = ref.current;
      const ghost = p.ghost; // fixed for this turn
      const turn = p.scope.begin(p.chat.id); // a chat switch aborts this stream and drops later UI updates
      const signal = AbortSignal.any([abortSignal, turn.signal]);
      const history = toChatMessages(messages as never);
      const stored = toStoredMessages(messages as never);
      const persona = p.persona ? { name: p.persona.name, system_prompt: p.persona.systemPrompt } : undefined;
      const agent = !!p.webSearch; // the model decides per message whether to search
      const incognito = p.incognito; // the route this turn is sent to, kept with the reply
      // Tool steps are shown live only; history keeps the answer text, not the queries (nothing new in storage).
      let text = ""; let receipt: Receipt | undefined; let tools: ToolEvent[] = [];
      const settled = () => tools.map((t) => (t.status === "running" ? { ...t, status: "error" as const } : t));
      const save = (signed?: Signed) => {
        if (turn.discarded()) return; // the chat was deleted or wiped meanwhile
        const msgs = turnToStore(stored, text, signed, incognito);
        const first = history.find((m) => m.role === "user")?.content ?? "New chat";
        p.onSaved({ ...p.chat, title: p.chat.messages.length ? p.chat.title : first.slice(0, 48), messages: msgs, updatedAt: Date.now() }, ghost, turn.current());
      };
      const reply = async function* (): AsyncGenerator<ChatModelRunResult, void> {
        try {
          for await (const u of streamChat({ model: p.modelRef, messages: history, persona, signal, agent })) {
            text = u.text; tools = u.tools; if (u.receipt) receipt = u.receipt; if (u.remaining !== undefined) p.onUsage(u.remaining, u.limit, u.quota);
            yield { content: [{ type: "text", text }], metadata: { custom: { tools, incognito } } };
          }
        } catch (e) {
          if (signal.aborted) { save(); yield { content: [{ type: "text", text }], metadata: { custom: { tools: settled(), incognito } } }; return; } // keep what streamed so far, no error text
          if (e instanceof ProviderFailure) p.onProviderFailure(p.modelRef);
          text = `⚠️ ${(e as Error).message}`; save();
          yield { content: [{ type: "text", text }], metadata: { custom: { tools: settled(), incognito } }, status: { type: "incomplete", reason: "error", error: (e as Error).message } };
          return;
        }
        save();
        if (receipt) {
          const signed = await p.verifySignature(receipt, p.modelRef).catch(() => "n/a" as const);
          save(signed);
          yield { content: [{ type: "text", text }], metadata: { custom: { signed, tools, incognito } } };
        }
      };
      try { yield* reply(); } finally { turn.end(); }
    },
  }), []);

  const initialMessages = useMemo<ThreadMessageLike[]>(() => (props.chat.messages as StoredMsg[]).map((m) => {
    const signed = m.role === "assistant" ? normalizeSigned(m.signed) : undefined;
    const incognito = m.role === "assistant" ? normalizeIncognito(m.incognito) : undefined;
    return { role: m.role, content: m.content, ...(signed || incognito ? { metadata: { custom: { ...(signed ? { signed } : {}), ...(incognito ? { incognito } : {}) } } } : {}) };
  }), [props.chat.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const runtime = useLocalRuntime(adapter, { initialMessages });

  const { handoff, onHandoff } = props;
  const used = useRef<typeof handoff>(null); // StrictMode runs effects twice: send once
  useEffect(() => {
    if (!handoff || used.current === handoff) return;
    used.current = handoff; onHandoff?.();
    if (handoff.send) runtime.thread.append(handoff.text);
    else runtime.thread.composer.setText(handoff.text);
  }, [handoff, onHandoff, runtime]);

  const [hi, em] = greeting(new Date().getHours(), props.ghost);
  const composer = (big: boolean) => (
    <ComposerPrimitive.Root className={`composer ${big ? "big" : ""}`}>
      <ComposerPrimitive.Input className="composer-input" data-testid="prompt" aria-label="Message" rows={big ? 3 : 1} autoFocus
        placeholder={big ? (props.ghost ? "Ask anything. This chat won't be saved." : "Ask anything, privately…") : (props.ghost ? "Reply — not saved" : "Reply…")} />
      <div className="composer-bar">
        {props.toolsSlot ?? <>
          <Soon icon={<Paperclip weight="duotone" aria-hidden />} label="Attach a file" />
          <Soon icon={<Lightbulb weight="duotone" aria-hidden />} label="Think longer" />
        </>}
        {props.ghostToggle}
        <div className="grow" />
        {props.modelSlot}
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send className="send-btn" data-testid="send" disabled={!props.modelRef} aria-label="Send"><ArrowUp weight="bold" aria-hidden /></ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="send-btn stop" data-testid="stop" aria-label="Stop"><Stop weight="fill" aria-hidden /></ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
  );
  const hints = props.hint && <p className="composer-hint" data-testid="composer-hint">{props.hint}</p>;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Empty>
          <div className="welcome" data-testid="welcome">
            <div className="welcome-col">
              <h1>{props.persona ? props.persona.name : <>{hi} <em>{em}</em></>}</h1>
              <p className="sr-only">{props.anonymized ? ANONYMIZED_NOTE : enclaveLine(props.modelRef)}</p>
              {composer(true)}
              {hints}
              <div className="suggestions">
                {(props.suggestions ?? []).map((s) => (
                  <ThreadPrimitive.Suggestion key={s} prompt={s} send className="suggestion">{s}</ThreadPrimitive.Suggestion>
                ))}
              </div>
            </div>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.If empty={false}>
          <ThreadPrimitive.Viewport className="viewport">
            <ThreadPrimitive.Messages>
              {({ message }) => (
                <Message role={message.role} content={textOf(message.content as never)} running={message.status?.type === "running"} isLast={message.isLast}
                  signed={normalizeSigned((message.metadata?.custom as { signed?: unknown } | undefined)?.signed)}
                  tools={(message.metadata?.custom as { tools?: ToolEvent[] } | undefined)?.tools} onOpenProof={props.onOpenProof}
                  incognito={normalizeIncognito((message.metadata?.custom as { incognito?: unknown } | undefined)?.incognito)} />
              )}
            </ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>
          <div className="composer-dock">
            {composer(false)}
            {hints}
            {!props.hint && <p className="composer-hint">{props.ghost ? "Close the tab and it's gone." : "Encrypted in this browser. Relayed, never logged."}</p>}
          </div>
        </ThreadPrimitive.If>
        <div className="sr-only" role="status">
          <ThreadPrimitive.If running>Assistant is responding</ThreadPrimitive.If>
          <ThreadPrimitive.If running={false} empty={false}>Reply ready</ThreadPrimitive.If>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
