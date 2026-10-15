"use client";
import { useState } from "react";
import { ChatCircle, Code, GraduationCap, Heartbeat, LockSimple, PencilSimpleLine, Plus, Trash, UserFocus, type Icon } from "@phosphor-icons/react";
import type { Persona } from "@/lib/personas";

/** Starter templates (our own text). Adding one copies it into the user's private, local personas. */
const TEMPLATES: { name: string; systemPrompt: string; icon: Icon }[] = [
  { name: "Careful editor", systemPrompt: "You are a precise editor. Improve clarity and grammar, keep the author's voice, and list the changes you made.", icon: PencilSimpleLine },
  { name: "Patient tutor", systemPrompt: "You are a patient tutor. Explain step by step, check understanding with short questions, and avoid jargon.", icon: GraduationCap },
  { name: "Code reviewer", systemPrompt: "You are a senior code reviewer. Point out bugs, security issues and simpler alternatives. Be concise.", icon: Code },
  { name: "Health notes helper", systemPrompt: "Help organise personal health notes and questions for a doctor. You are not a doctor; flag anything urgent.", icon: Heartbeat },
];

export function PersonaGallery({ personas, disabled, onAdd, onDelete, onUse }: {
  personas: Persona[]; disabled: boolean;
  onAdd: (name: string, prompt: string) => boolean; onDelete: (id: string) => void; onUse: (id: string) => void;
}) {
  const [name, setName] = useState(""); const [prompt, setPrompt] = useState(""); const [armed, setArmed] = useState("");
  return (
    <div className="page" data-testid="personas-view">
      <h1>Personas</h1>
      <p className="lede"><LockSimple aria-hidden />Personas are private: they are encrypted and stored only in this browser, and sent to the enclave only as the system prompt of your own chats.</p>

      <h2>Your personas</h2>
      <div className="cards">
        {personas.map((p) => (
          <div className="card" key={p.id} data-testid="persona-card">
            <div className="card-title"><UserFocus aria-hidden />{p.name}</div>
            <p className="small muted clamp">{p.systemPrompt}</p>
            <div className="row gap card-actions">
              <button type="button" className="btn primary" onClick={() => onUse(p.id)} aria-label={`Chat with ${p.name}`}><ChatCircle aria-hidden />Chat</button>
              {armed === p.id
                ? <button type="button" className="btn danger" autoFocus onBlur={() => setArmed("")} onClick={() => { setArmed(""); onDelete(p.id); }}
                    aria-label={`Really delete ${p.name}`}><Trash aria-hidden />Really delete</button>
                : <button type="button" className="btn ghost" onClick={() => setArmed(p.id)} disabled={disabled} aria-label={`Delete ${p.name}`}><Trash aria-hidden />Delete</button>}
            </div>
          </div>
        ))}
        <form className="card new" onSubmit={(e) => { e.preventDefault(); if (onAdd(name, prompt)) { setName(""); setPrompt(""); } }}>
          <div className="card-title"><Plus aria-hidden />New persona</div>
          <label className="field"><span>Name</span>
            <input data-testid="persona-name" value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} />
          </label>
          <label className="field"><span>System prompt</span>
            <textarea data-testid="persona-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={disabled} rows={3} />
            <small>Stays in this browser.</small>
          </label>
          <button type="submit" className="btn primary" data-testid="persona-add" disabled={disabled}>Save persona</button>
          {disabled && <p className="small muted">Unavailable in ghost chat.</p>}
        </form>
      </div>

      <h2>Start from a template</h2>
      <div className="cards">
        {TEMPLATES.map((t) => (
          <div className="card" key={t.name}>
            <div className="card-title"><t.icon aria-hidden />{t.name}</div>
            <p className="small muted clamp">{t.systemPrompt}</p>
            <button type="button" className="btn" disabled={disabled} onClick={() => onAdd(t.name, t.systemPrompt)}><Plus aria-hidden />Add to my personas</button>
          </div>
        ))}
      </div>
    </div>
  );
}
