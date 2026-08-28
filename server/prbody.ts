/**
 * The pull request body, rendered here from the round's findings.
 *
 * It used to be prose the agent wrote and sent, which meant the app could
 * never show you what a round had actually said — the body went straight to
 * GitHub and nothing kept a copy. Worse, the body and the round block were
 * written separately, so a round could report one thing and open a pull
 * request saying another, and nobody would ever notice.
 *
 * So the agent now sends the *findings* and the server renders the body from
 * them. The same objects go into the round block the UI reads, which is what
 * makes "what this pull request changes" and "what the app says it changes"
 * the same sentence by construction rather than by the agent's diligence.
 *
 * Markdown, because that is what GitHub renders. Deliberately plain: a
 * maintainer skims this in a notification email.
 */
import { LIMITS, ruleDocUrl, type Finding } from "./contract";

export interface BodyInput {
  file: string;
  findings: Finding[];
  /** Merge-worthy counts from the round's own verification. */
  before?: number;
  after?: number;
}

const SEVERITY_LABEL: Record<string, string> = { error: "error", warning: "warning", info: "info" };

/**
 * A bullet per finding, in the order the agent sent them — it clustered them,
 * so it knows which one is the reason and which one came along.
 */
function bullet(f: Finding): string {
  const rule = `[${f.checkId}](${ruleDocUrl(f.checkId)})`;
  const where = f.entity ? ` in \`${f.entity}\`` : "";
  const what = f.note?.trim() || f.remediation?.trim() || f.message.trim();
  return `- **${f.title}** (${rule})${where} — ${what}`;
}

/**
 * Render the body. Never includes the marker: `bodyWithMarker` appends that,
 * because the marker is the server's claim on the pull request and belongs to
 * the one place that writes it.
 */
export function renderBody(input: BodyInput): string {
  const { file, findings } = input;
  const lines: string[] = [];

  const n = findings.length;
  const severities = new Set(findings.map((f) => SEVERITY_LABEL[f.severity] ?? "warning"));
  const kinds = [...severities].join(" and ");
  lines.push(
    n === 1
      ? `chant flagged one ${kinds} in \`${file}\`. This pull request fixes it.`
      : `chant flagged ${n} things in \`${file}\`. This pull request fixes them.`,
  );
  lines.push("");

  for (const f of findings) lines.push(bullet(f));

  // The judgment calls are the half worth a second look, and the half a
  // maintainer will not spot from the diff alone. Say so explicitly.
  const guidance = findings.filter((f) => f.fixKind === "guidance");
  if (guidance.length > 0) {
    lines.push("");
    lines.push(
      guidance.length === 1
        ? `> **${guidance[0]!.checkId} is a judgment call.** chant was confident something was wrong but would not guess at the fix, so this change is mine — please check it against what you meant the file to do.`
        : `> **${guidance.length} of these are judgment calls** (${guidance.map((f) => f.checkId).join(", ")}). chant was confident something was wrong but would not guess at the fix, so those changes are mine — please check them against what you meant the file to do.`,
    );
  }

  if (input.before !== undefined && input.after !== undefined) {
    lines.push("");
    lines.push(`Verified by re-running the audit: merge-worthy findings ${input.before} → ${input.after}.`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Opened by [Rounds](https://rounds.demo.managoat.com), which audits this repository's configuration on a schedule. " +
      "Close it without merging and this file will never be raised again.",
  );

  // Each finding is capped, but fifty of them are not. A body GitHub would
  // reject is worse than one that stops early and says so.
  const rendered = lines.join("\n");
  if (rendered.length <= LIMITS.body) return rendered;
  const cut = rendered.slice(0, LIMITS.body - 200);
  return `${cut.slice(0, cut.lastIndexOf("\n"))}\n\n_…truncated. The diff is the complete change._\n`;
}
