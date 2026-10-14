"use client";
import { useState } from "react";
import type { Persona } from "@/lib/personas";

/** Starter templates (our own text). Adding one copies it into the user's private, local personas. */
const TEMPLATES = [
  { name: "Careful editor", systemPrompt: "You are a precise editor. Improve clarity and grammar, keep the author's voice, and list the changes you made.", icon: "✍️" },
  { name: "Patient tutor", systemPrompt: "You are a patient tutor. Explain step by step, check understanding with short questions, and avoid jargon.", icon: "🎓" },
  { name: "Code reviewer", systemPrompt: "You are a senior code reviewer. Point out bugs, security issues and simpler alternatives. Be concise.", icon: "🧑‍💻" },
  { name: "Health notes helper", systemPrompt: "Help organise personal health notes and questions for a doctor. You are not a doctor; flag anything urgent.", icon: "🩺" },
];

export function PersonaGallery({ personas, disabled, onAdd, onDelete, onUse }: {
  personas: Persona[]; disabled: boolean;
  onAdd: (name: string, prompt: string) => boolean; onDelete: (id: string) => void; onUse: (id: string) => void;
}) {
  const [name, setName] = useState(""); const [prompt, setPrompt] = useState("");
  return (
    <div className="page" data-testid="personas-view">
      <h1>Personas</h1>
      <p className="muted">Personas are private: they are encrypted and stored only in this browser, and sent to the enclave only as the system prompt of your own chats.</p>

      <h2>Your personas</h2>
      <div className="cards">
        {personas.map((p) => (
          <div className="card" key={p.id} data-testid="persona-card">
            <div className="card-title">🧩 {p.name}</div>
            <p className="small muted clamp">{p.systemPrompt}</p>
            <div className="row gap">
              <button type="button" className="btn primary" onClick={() => onUse(p.id)}>Chat</button>
              <button type="button" className="btn ghost" onClick={() => onDelete(p.id)} disabled={disabled}>Delete</button>
            </div>
          </div>
        ))}
        <form className="card new" onSubmit={(e) => { e.preventDefault(); if (onAdd(name, prompt)) { setName(""); setPrompt(""); } }}>
          <div className="card-title">New persona</div>
          <input data-testid="persona-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} />
          <textarea data-testid="persona-prompt" placeholder="System prompt (stays in this browser)" value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={disabled} rows={3} />
          <button type="submit" className="btn primary" data-testid="persona-add" disabled={disabled}>Save persona</button>
          {disabled && <p className="small muted">Unavailable in ghost chat.</p>}
        </form>
      </div>

      <h2>Start from a template</h2>
      <div className="cards">
        {TEMPLATES.map((t) => (
          <div className="card" key={t.name}>
            <div className="card-title">{t.icon} {t.name}</div>
            <p className="small muted clamp">{t.systemPrompt}</p>
            <button type="button" className="btn" disabled={disabled} onClick={() => onAdd(t.name, t.systemPrompt)}>Add to my personas</button>
          </div>
        ))}
      </div>
    </div>
  );
}
