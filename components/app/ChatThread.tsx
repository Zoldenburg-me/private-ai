"use client";
import { useMemo, useRef } from "react";
import {
  AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive, useLocalRuntime,
  type ChatModelAdapter, type ChatModelRunResult, type ThreadMessageLike,
} from "@assistant-ui/react";
import Image from "next/image";
import { ArrowUp, CheckCircle, MinusCircle, Stop, XCircle } from "@phosphor-icons/react";
import { SafeMarkdown } from "@/components/markdown";
import { streamChat, toChatMessages, toStoredMessages, type StoredMsg } from "@/lib/client/chat-stream";
import { normalizeSigned, type Signed } from "@/lib/client/proof";
import type { Receipt } from "@/lib/sse";
import type { Chat } from "@/lib/storage";
import type { Persona } from "@/lib/personas";
import type { ChatScope } from "@/lib/chat-scope";

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
}

function textOf(content: readonly { type: string; text?: string }[]) {
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

function Message({ role, content, signed }: { role: string; content: string; signed?: Signed }) {
  return (
    <div className={`msg msg-${role}`} data-testid={`msg-${role}`}>
      {role === "assistant" && <div className="avatar" aria-hidden><Image src="/brand/narwhal.svg" alt="" width={20} height={11} unoptimized /></div>}
      <div className="bubble">
        <span className="sr-only">{role === "user" ? "You said:" : "Assistant:"}</span>
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

  const adapter = useMemo<ChatModelAdapter>(() => ({
    async *run({ messages, abortSignal }) {
      const p = ref.current;
      const ghost = p.ghost; // fixed for this turn
      const turn = p.scope.begin(p.chat.id); // a chat switch aborts this stream and drops later UI updates
      const signal = AbortSignal.any([abortSignal, turn.signal]);
      const history = toChatMessages(messages as never);
      const stored = toStoredMessages(messages as never);
      const persona = p.persona ? { name: p.persona.name, system_prompt: p.persona.systemPrompt } : undefined;
      let text = ""; let receipt: Receipt | undefined;
      const save = (signed?: Signed) => {
        if (turn.discarded()) return; // chat was deleted or wiped meanwhile
        const msgs: StoredMsg[] = [...stored, { role: "assistant", content: text, ...(signed ? { signed } : {}) }];
        const first = history.find((m) => m.role === "user")?.content ?? "New chat";
        p.onSaved({ ...p.chat, title: p.chat.messages.length ? p.chat.title : first.slice(0, 48), messages: msgs, updatedAt: Date.now() }, ghost, turn.current());
      };
      const reply = async function* (): AsyncGenerator<ChatModelRunResult, void> {
        try {
          for await (const u of streamChat({ model: p.modelRef, messages: history, persona, signal })) {
            text = u.text; if (u.receipt) receipt = u.receipt; if (u.remaining !== undefined) p.onUsage(u.remaining);
            yield { content: [{ type: "text", text }] };
          }
        } catch (e) {
          if (signal.aborted) { save(); return; } // keep what streamed so far, no error text
          text = `⚠️ ${(e as Error).message}`; save();
          yield { content: [{ type: "text", text }], status: { type: "incomplete", reason: "error", error: (e as Error).message } };
          return;
        }
        save();
        if (receipt) {
          const signed = await p.verifySignature(receipt).catch(() => "n/a" as const);
          save(signed);
          yield { content: [{ type: "text", text }], metadata: { custom: { signed } } };
        }
      };
      try { yield* reply(); } finally { turn.end(); }
    },
  }), []);

  const initialMessages = useMemo<ThreadMessageLike[]>(() => (props.chat.messages as StoredMsg[]).map((m) => ({
    role: m.role, content: m.content, ...(m.role === "assistant" && normalizeSigned(m.signed) ? { metadata: { custom: { signed: normalizeSigned(m.signed) } } } : {}),
  })), [props.chat.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const runtime = useLocalRuntime(adapter, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="viewport">
          <ThreadPrimitive.Empty>
            <div className="welcome" data-testid="welcome">
              <div className="logo-mark" aria-hidden><Image src="/brand/narwhal.svg" alt="" width={40} height={22} unoptimized /></div>
              <h1>{props.persona ? props.persona.name : "Ask anything, privately"}</h1>
              <p className="muted">Runs inside an attested enclave on NEAR AI Cloud. Your history stays encrypted in this browser.</p>
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
                signed={normalizeSigned((message.metadata?.custom as { signed?: unknown } | undefined)?.signed)} />
            )}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input className="composer-input" data-testid="prompt" placeholder={props.ghost ? "Ghost chat: nothing will be saved…" : "Ask privately…"} rows={1} autoFocus />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="send-btn" data-testid="send" disabled={!props.modelRef} aria-label="Send"><ArrowUp weight="bold" aria-hidden /></ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="send-btn stop" data-testid="stop" aria-label="Stop"><Stop weight="fill" aria-hidden /></ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
