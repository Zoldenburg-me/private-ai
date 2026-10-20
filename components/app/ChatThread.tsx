"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive, useLocalRuntime,
  type ChatModelAdapter, type ChatModelRunResult, type ThreadMessageLike,
} from "@assistant-ui/react";
import Image from "next/image";
import { ArrowUp, CheckCircle, MagnifyingGlass, MinusCircle, Stop, XCircle } from "@phosphor-icons/react";
import { SafeMarkdown } from "@/components/markdown";
import { streamChat, toChatMessages, toStoredMessages, type StoredMsg } from "@/lib/client/chat-stream";
import { normalizeSigned, type Signed } from "@/lib/client/proof";
import type { Receipt, ToolEvent } from "@/lib/sse";
import type { Chat } from "@/lib/storage";
import type { Persona } from "@/lib/personas";
import type { ChatScope } from "@/lib/chat-scope";
import { ANONYMIZED_NOTE } from "@/lib/client/providers";

export type { Signed, StoredMsg };

export interface ThreadProps {
  chat: Chat;
  modelRef: string;
  persona?: Persona;
  ghost: boolean;
  /** isCurrent=false: the user switched chats mid-stream; persist, but do not show. */
  onSaved: (chat: Chat, ghost: boolean, isCurrent: boolean) => void;
  scope: ChatScope;
  onUsage: (remaining: string | null) => void;
  verifySignature: (r: Receipt) => Promise<Signed>;
  suggestions?: string[];
  /** The selected model is anonymized: no enclave, so the welcome text must not claim one. */
  anonymized?: boolean;
  /** Homepage hand-off: send this prompt as the first message, or only put it in the composer. */
  handoff?: { text: string; send: boolean } | null;
  onHandoff?: () => void;
  /** Small line under the composer (e.g. the sign-up hint for signed-out visitors). */
  hint?: ReactNode;
  /** The server offers agent mode with web search (/api/session features.webSearch). */
  webSearch?: boolean;
}

function textOf(content: readonly { type: string; text?: string }[]) {
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

const httpUrl = (u: string) => /^https?:\/\//i.test(u);
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
              <ul>{t.results.filter((r) => httpUrl(r.url)).map((r, i) => (
                <li key={`${i}:${r.url}`}><a href={r.url} target="_blank" rel="noopener noreferrer nofollow">{r.title || r.url}<span className="sr-only"> (opens in a new tab)</span></a> <span>· {hostOf(r.url)}</span></li>
              ))}</ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Message({ role, content, signed, tools }: { role: string; content: string; signed?: Signed; tools?: ToolEvent[] }) {
  return (
    <div className={`msg msg-${role}`} data-testid={`msg-${role}`}>
      {role === "assistant" && <div className="avatar" aria-hidden><Image src="/brand/narwhal.svg" alt="" width={20} height={11} unoptimized /></div>}
      <div className="bubble">
        <span className="sr-only">{role === "user" ? "You said:" : "Assistant:"}</span>
        {tools && tools.length > 0 && <ToolSteps tools={tools} />}
        {role === "assistant" ? <div className="md"><SafeMarkdown text={content || "…"} /></div> : <span className="pre">{content}</span>}
        {signed === "enclave" && <div className="sig ok" data-testid="signed"><CheckCircle weight="fill" aria-hidden />signed by enclave</div>}
        {signed === "key-match" && <div className="sig warn" data-testid="signed-key-match"><CheckCircle aria-hidden />signature matches the enclave&apos;s reported key · chain not verified</div>}
        {signed === "fail" && <div className="sig bad" data-testid="signed-fail"><XCircle aria-hidden />signature mismatch</div>}
        {signed === "n/a" && <div className="sig muted"><MinusCircle aria-hidden />signature not available</div>}
      </div>
    </div>
  );
}

/** One conversation, rendered with assistant-ui primitives on a LocalRuntime backed by /api/chat. */
export function ChatThread(props: ThreadProps) {
  const ref = useRef(props); ref.current = props;
  const [search, setSearch] = useState(false);
  const searchOn = search && !!props.webSearch;
  const searchRef = useRef(searchOn); searchRef.current = searchOn;
  // Losing the feature (e.g. signing out) clears the opt-in, so it never comes back switched on by itself.
  useEffect(() => { if (!props.webSearch) setSearch(false); }, [props.webSearch]);

  const adapter = useMemo<ChatModelAdapter>(() => ({
    async *run({ messages, abortSignal }) {
      const p = ref.current;
      const ghost = p.ghost; // fixed for this turn
      const turn = p.scope.begin(p.chat.id); // a chat switch aborts this stream and drops later UI updates
      const signal = AbortSignal.any([abortSignal, turn.signal]);
      const history = toChatMessages(messages as never);
      const stored = toStoredMessages(messages as never);
      const persona = p.persona ? { name: p.persona.name, system_prompt: p.persona.systemPrompt } : undefined;
      const agent = searchRef.current; // fixed for this turn
      // Tool steps are shown live only; history keeps the answer text, not the queries (nothing new in storage).
      let text = ""; let receipt: Receipt | undefined; let tools: ToolEvent[] = [];
      const settled = () => tools.map((t) => (t.status === "running" ? { ...t, status: "error" as const } : t));
      const save = (signed?: Signed) => {
        if (turn.discarded()) return; // chat was deleted or wiped meanwhile
        const msgs: StoredMsg[] = [...stored, { role: "assistant", content: text, ...(signed ? { signed } : {}) }];
        const first = history.find((m) => m.role === "user")?.content ?? "New chat";
        p.onSaved({ ...p.chat, title: p.chat.messages.length ? p.chat.title : first.slice(0, 48), messages: msgs, updatedAt: Date.now() }, ghost, turn.current());
      };
      const reply = async function* (): AsyncGenerator<ChatModelRunResult, void> {
        try {
          for await (const u of streamChat({ model: p.modelRef, messages: history, persona, signal, agent })) {
            text = u.text; tools = u.tools; if (u.receipt) receipt = u.receipt; if (u.remaining !== undefined) p.onUsage(u.remaining);
            yield { content: [{ type: "text", text }], metadata: { custom: { tools } } };
          }
        } catch (e) {
          if (signal.aborted) { save(); yield { content: [{ type: "text", text }], metadata: { custom: { tools: settled() } } }; return; } // keep what streamed so far, no error text
          text = `⚠️ ${(e as Error).message}`; save();
          yield { content: [{ type: "text", text }], metadata: { custom: { tools: settled() } }, status: { type: "incomplete", reason: "error", error: (e as Error).message } };
          return;
        }
        save();
        if (receipt) {
          const signed = await p.verifySignature(receipt).catch(() => "n/a" as const);
          save(signed);
          yield { content: [{ type: "text", text }], metadata: { custom: { signed, tools } } };
        }
      };
      try { yield* reply(); } finally { turn.end(); }
    },
  }), []);

  const initialMessages = useMemo<ThreadMessageLike[]>(() => (props.chat.messages as StoredMsg[]).map((m) => ({
    role: m.role, content: m.content, ...(m.role === "assistant" && normalizeSigned(m.signed) ? { metadata: { custom: { signed: normalizeSigned(m.signed) } } } : {}),
  })), [props.chat.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const runtime = useLocalRuntime(adapter, { initialMessages });

  const { handoff, onHandoff } = props;
  const used = useRef<typeof handoff>(null); // StrictMode runs effects twice: send once
  useEffect(() => {
    if (!handoff || used.current === handoff) return;
    used.current = handoff; onHandoff?.();
    if (handoff.send) runtime.thread.append(handoff.text);
    else runtime.thread.composer.setText(handoff.text);
  }, [handoff, onHandoff, runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="viewport">
          <ThreadPrimitive.Empty>
            <div className="welcome" data-testid="welcome">
              <div className="logo-mark" aria-hidden><Image src="/brand/narwhal.svg" alt="" width={40} height={22} unoptimized /></div>
              <h1>{props.persona ? props.persona.name : "Ask anything, privately"}</h1>
              <p className="muted">{props.anonymized ? ANONYMIZED_NOTE : "Runs inside an attested enclave on NEAR AI Cloud."} {props.ghost ? "Ghost chat: nothing is saved." : "Your history stays encrypted in this browser."}</p>
              <div className="suggestions">
                {(props.suggestions ?? []).map((s) => (
                  <ThreadPrimitive.Suggestion key={s} prompt={s} send className="suggestion">{s}</ThreadPrimitive.Suggestion>
                ))}
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => (
              <Message role={message.role} content={textOf(message.content as never)}
                signed={normalizeSigned((message.metadata?.custom as { signed?: unknown } | undefined)?.signed)}
                tools={(message.metadata?.custom as { tools?: ToolEvent[] } | undefined)?.tools} />
            )}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <div className="sr-only" role="status">
          <ThreadPrimitive.If running>Assistant is responding</ThreadPrimitive.If>
          <ThreadPrimitive.If running={false} empty={false}>Reply ready</ThreadPrimitive.If>
        </div>
        <ComposerPrimitive.Root className="composer">
          {props.webSearch && (
            <button type="button" className={`tool-toggle ${searchOn ? "on" : ""}`} data-testid="web-search-toggle" aria-pressed={searchOn}
              title="Let the model search the web. The search queries it writes are sent to Brave Search." onClick={() => setSearch((s) => !s)}>
              <MagnifyingGlass aria-hidden /><span className="tool-toggle-label">Web search</span>
            </button>
          )}
          <ComposerPrimitive.Input className="composer-input" data-testid="prompt" aria-label="Message" placeholder={props.ghost ? "Ghost chat: nothing will be saved…" : "Ask privately…"} rows={1} autoFocus />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="send-btn" data-testid="send" disabled={!props.modelRef} aria-label="Send"><ArrowUp weight="bold" aria-hidden /></ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="send-btn stop" data-testid="stop" aria-label="Stop"><Stop weight="fill" aria-hidden /></ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
        {searchOn && <p className="composer-hint" data-testid="web-search-hint">Web search is on: search queries the model writes, which can repeat parts of your message, go to Brave Search. Your chat history does not.</p>}
        {props.hint && <p className="composer-hint" data-testid="composer-hint">{props.hint}</p>}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
