/** Hand-off from the hero chat bar to /chat. The prompt goes in the fragment, which never reaches the server. */
export function chatUrl(text: string): string | null {
  const q = text.trim();
  return q ? `/chat?ghost=1#q=${encodeURIComponent(q)}` : null;
}
