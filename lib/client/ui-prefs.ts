/** Desktop sidebar collapsed or not: a UI preference, never content (tests/ghost.test.ts allows only this key). */
export const SIDEBAR_KEY = "pai.ui.sidebar-collapsed";

export function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; } // blocked storage: default open
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch { /* not remembered; the toggle still works */ }
}
