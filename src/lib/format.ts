export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A conversation's display line: its title, else a trimmed first prompt, else the id. */
export function conversationLabel(c: { title: string | null; id: string }, firstPrompt?: string | null): string {
  if (c.title) return c.title;
  if (firstPrompt) {
    const t = firstPrompt.replace(/\s+/g, " ").trim();
    return t.length > 80 ? t.slice(0, 80) + "…" : t;
  }
  return shortId(c.id);
}
