import { AUTO, isLevel, type Level } from "./levels";

/** Desktop sidebar collapsed or not: a UI preference, never content (tests/ghost.test.ts allows only this key and MODE_KEY). */
export const SIDEBAR_KEY = "pai.ui.sidebar-collapsed";

export function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; } // blocked storage: default open
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch { /* not remembered; the toggle still works */ }
}

/** Privacy level, model pick per level ("auto" or a model ref) and tool settings: UI preferences, never content (tests/ghost.test.ts). */
export const MODE_KEY = "pai.ui.mode";
export interface ModePrefs { level: Level; picks: Record<Level, string>; webSearch: boolean; pickProvider: boolean }
export const DEFAULT_MODE: ModePrefs = { level: "max", picks: { max: AUTO, medium: AUTO, anon: AUTO }, webSearch: true, pickProvider: false };
const MAX_PICK_CHARS = 200;

/** Reads a stored value field by field: browser storage is untrusted, so anything unexpected falls back to the default. */
export function parseModePrefs(raw: string | null): ModePrefs {
  let j: Record<string, unknown>;
  try { const v: unknown = JSON.parse(raw ?? ""); if (!v || typeof v !== "object" || Array.isArray(v)) return DEFAULT_MODE; j = v as Record<string, unknown>; } catch { return DEFAULT_MODE; }
  const picks = (j.picks && typeof j.picks === "object" ? j.picks : {}) as Record<string, unknown>;
  const pick = (l: Level) => { const v = Object.hasOwn(picks, l) ? picks[l] : undefined; return typeof v === "string" && v && v.length <= MAX_PICK_CHARS ? v : AUTO; };
  return {
    level: isLevel(j.level) ? j.level : DEFAULT_MODE.level,
    picks: { max: pick("max"), medium: pick("medium"), anon: pick("anon") },
    webSearch: typeof j.webSearch === "boolean" ? j.webSearch : DEFAULT_MODE.webSearch,
    pickProvider: typeof j.pickProvider === "boolean" ? j.pickProvider : DEFAULT_MODE.pickProvider,
  };
}

export function readModePrefs(): ModePrefs {
  try { return parseModePrefs(localStorage.getItem(MODE_KEY)); } catch { return DEFAULT_MODE; } // blocked storage: defaults
}

export function writeModePrefs(p: ModePrefs): void {
  try { localStorage.setItem(MODE_KEY, JSON.stringify(p)); } catch { /* not remembered; the choice still applies */ }
}

/**
 * Wide screens only: whether the sidebar is hidden. At 1025-1279px an open proof drawer takes its place
 * (the header would not fit beside both); the saved preference is untouched by that.
 */
export function sidebarHidden(s: { narrow: boolean; cramped: boolean; drawer: boolean; collapsed: boolean }): boolean {
  return !s.narrow && (s.collapsed || (s.cramped && s.drawer));
}
