/**
 * Review comments: what people in a chat say about a line of the changes
 * (shared/changes.ts), kept by Salon and shown to everyone on the panel.
 * A comment is not a turn. "Send to the model" gathers the open ones into
 * one prompt — this file writes it — and that prompt is the turn, sent by
 * whoever pressed the button and tagged as theirs, with each comment's own
 * author named inside.
 */
import { parseDiff, shortSha, type ChangesDto } from "./changes";

export type Side = "new" | "old";
export type CommentAnchor = "diff_line" | "plan_node" | "plan_field";

export interface CommentDto {
  id: string;
  chatId: string;
  /** The changes snapshot the comment was made on; the line number is in that diff. */
  changesSeq: number;
  path: string;
  side: Side;
  line: number;
  /** The line's text at the time, so a comment still reads once the diff has moved. */
  quote: string;
  body: string;
  author: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Set once the comment has gone to the model in a prompt. */
  sentAt: string | null;
  sentBy: string | null;
  /** Omitted by older clients/records; absence means a diff line. */
  anchorKind?: CommentAnchor;
  planNodeId?: string | null;
  planField?: string | null;
}

export const COMMENT_MAX = 4000;

/** The comment a request carried, or the sentence that says why not. */
export function parseComment(v: unknown): { anchorKind?: CommentAnchor; path: string; side: Side; line: number; planNodeId?: string | null; planField?: string | null; body: string } | string {
  if (!v || typeof v !== "object") return "A comment is required.";
  const r = v as Record<string, unknown>;
  const anchorKind: CommentAnchor = r.anchorKind === "plan_node" || r.anchorKind === "plan_field" ? r.anchorKind : "diff_line";
  const body = typeof r.body === "string" ? r.body.trim().slice(0, COMMENT_MAX) : "";
  if (!body) return "Say something.";
  if (anchorKind !== "diff_line") {
    const planNodeId = typeof r.planNodeId === "string" ? r.planNodeId.trim().slice(0, 100) : "";
    if (!planNodeId) return "Say which plan node.";
    const planField = anchorKind === "plan_field" && typeof r.planField === "string" ? r.planField.trim().slice(0, 100) : null;
    if (anchorKind === "plan_field" && !planField) return "Say which plan field.";
    return { anchorKind, path: "", side: "new", line: 0, planNodeId, planField, body };
  }
  const path = typeof r.path === "string" ? r.path.trim().slice(0, 1000) : "";
  if (!path) return "Say which file.";
  const side: Side = r.side === "old" ? "old" : "new";
  const line = typeof r.line === "number" && Number.isInteger(r.line) && r.line > 0 ? r.line : 0;
  if (!line) return "Say which line.";
  return { path, side, line, body };
}

/** The text of a line in a diff, by file, side and number — "" when the diff does not have it. */
export function lineText(diff: string, path: string, side: Side, line: number): string {
  const file = parseDiff(diff).find((f) => f.path === path || f.oldPath === path);
  if (!file) return "";
  for (const h of file.hunks) for (const l of h.lines) if ((side === "new" ? l.newNo : l.oldNo) === line) return l.text;
  return "";
}

/** Open and not yet sent: what "Send to the model" gathers. */
export function pending(comments: readonly CommentDto[]): CommentDto[] {
  return comments.filter((c) => !c.resolvedAt && !c.sentAt);
}

/**
 * The prompt the comments become. Grouped by file, in file order then line
 * order, each with who said it, so the model can address people by name and
 * co-author them. The sender's own tag is added by the proxy rule, outside.
 */
export function reviewPrompt(comments: readonly CommentDto[], changes: Pick<ChangesDto, "branch" | "head"> | null): string {
  const diffComments = comments.filter((c) => !c.anchorKind || c.anchorKind === "diff_line");
  const byFile = new Map<string, CommentDto[]>();
  for (const c of [...diffComments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.createdAt.localeCompare(b.createdAt))) {
    byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  }
  const where = changes ? ` on ${changes.branch || shortSha(changes.head)}${changes.head ? ` at ${shortSha(changes.head)}` : ""}` : "";
  const out: string[] = [`Review comments${where}. Please address each one, then say in a sentence or two what you changed.`, ""];
  for (const [path, list] of byFile) {
    out.push(`${path}:`);
    for (const c of list) {
      const at = `line ${c.line}${c.side === "old" ? " (removed)" : ""}`;
      out.push(`- ${at}${c.quote ? ` — \`${c.quote.trim().slice(0, 120)}\`` : ""}`);
      out.push(`  ${c.author}: ${c.body.replace(/\n/g, "\n  ")}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}
