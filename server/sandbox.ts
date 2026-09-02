/**
 * A chat's computer, calling this server. Two routes hear from it — the
 * MCP server the model uses (server/mcp.ts) and the changes hook
 * (server/changes.ts) — and both know who is asking the same way:
 *
 *   - The bearer is the key Fountain minted for the conversation and put in
 *     the computer's environment as `$FOUNTAIN_TOKEN`. Salon asks Fountain
 *     `GET /api/auth/me` on it, the same call sign-in makes, and takes the
 *     email. The verdict is cached briefly under a hash of the key.
 *   - `X-Fountain-Conversation-Id` — `$FOUNTAIN_CONVERSATION_ID` in the same
 *     environment — names the conversation, and the conversation names the
 *     chat. The key's email must be the chat's host, because that is whose
 *     key the conversation runs on. The caller then reaches that one chat
 *     and nothing else on this server.
 *
 * Nothing is issued or stored for this: a computer that can prove it is one
 * of the host's conversations is let into the chat that conversation is.
 *
 * The second half of this file is what gets *into* the computer: the setup
 * script a project's environment runs, which installs the hook that posts
 * the repository's changes back here (`hookSetupScript`).
 */
import type { AppContext } from "./context";
import { sha256 } from "./crypto";
import type { ChatRow } from "./db";
import { FountainClient, FountainHttpError } from "./fountain";
import { HttpError } from "./http";

export const CONVERSATION_HEADER = "x-fountain-conversation-id";

/** How long a key's verdict from Fountain is reused. Short: a revoked key must stop working. */
const KEY_CACHE_TTL_MS = 60 * 1000;
const verified = new Map<string, { email: string; at: number }>();

/** For tests: forget every verified key. */
export function resetSandboxCache(): void {
  verified.clear();
}

export interface SandboxCaller {
  email: string;
  chat: ChatRow;
  conversationId: string;
}

export async function sandboxCaller(ctx: AppContext, req: Request): Promise<SandboxCaller> {
  const header = req.headers.get("authorization") ?? "";
  const key = unescaped(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (!key) throw new HttpError(401, "unauthenticated", "Send a Fountain API key as `Authorization: Bearer …`; inside a chat's computer that is $FOUNTAIN_TOKEN.");
  const conversationId = unescaped(req.headers.get(CONVERSATION_HEADER)?.trim() ?? "");
  if (!conversationId) throw new HttpError(400, "no_conversation", `Send the conversation id as ${CONVERSATION_HEADER}; inside a chat's computer that is $FOUNTAIN_CONVERSATION_ID.`);
  const email = await whose(ctx, key);
  const chat = ctx.db.chatByConversation(conversationId);
  if (!chat || chat.owner_email !== email) throw new HttpError(404, "no_chat", "That conversation is not a Salon chat of yours.");
  return { email, chat, conversationId };
}

/**
 * A header value as the runtime sends it today. Fountain writes the agent's
 * `mcp_servers` into the computer twice: substituted into the project config
 * (`$${X}` → `${X}`, which the runtime expands from its environment), and raw
 * on the ACP session, where the runtime expands the inner `${X}` and leaves
 * the first `$` standing — so the token arrives as `$ftn_…`. The session copy
 * is the one the agent uses. Dropping one leading `$` accepts both, and costs
 * nothing: Fountain still has to recognise the key. Seen 2026-09-02; the
 * proper fix is Fountain sending the substituted config on the session.
 */
function unescaped(v: string): string {
  return v.startsWith("$") ? v.slice(1) : v;
}

/** The email Fountain says a key belongs to. */
async function whose(ctx: AppContext, key: string): Promise<string> {
  const hash = await sha256(key);
  const hit = verified.get(hash);
  if (hit && Date.now() - hit.at < KEY_CACHE_TTL_MS) return hit.email;
  let who: { email: string };
  try {
    who = await new FountainClient(ctx.config.fountainUrl, key).me();
  } catch (err) {
    if (err instanceof FountainHttpError && (err.status === 401 || err.status === 403)) throw new HttpError(401, "bad_key", "Fountain rejected that key.");
    throw new HttpError(502, "fountain_unreachable", `Could not reach ${ctx.config.fountainUrl} to verify the key.`);
  }
  const email = who.email.trim().toLowerCase();
  if (!email) throw new HttpError(502, "no_email", "Fountain did not say who the key belongs to.");
  verified.set(hash, { email, at: Date.now() });
  return email;
}

// ── what goes into the computer ──────────────────────────────────────────

/** Where the hook lives in the computer. The claude runtime's home; codex shares it. */
export const HOOK_DIR = "/home/sprite/.salon";
export const HOOK_SCRIPT = `${HOOK_DIR}/changes.sh`;
/**
 * Claude Code's *local* project settings. Fountain writes `~/.claude/settings.json`
 * itself, after the setup script and whole, so a hook there would be lost;
 * the local file beside it is read too (claude-agent-acp loads user, project
 * and local) and is nobody else's.
 */
export const LOCAL_SETTINGS = "/home/sprite/.claude/settings.local.json";

export interface HookOptions {
  /** This server as the computer reaches it: `PUBLIC_URL`. */
  publicUrl: string;
  /** Where the environment cloned the repository (`mount_path`). */
  repoPath: string;
  /** The branch the diff is against, as cloned: "main". */
  base: string;
}

/**
 * The bash a project's environment runs as its setup script: writes the hook
 * and tells Claude Code to run it when a session starts, after a file-changing
 * tool, and when a turn ends. Idempotent. The caller appends the project's
 * own setup command after it.
 */
export function hookSetupScript(o: HookOptions): string {
  return [
    "# Salon: the hook that posts this repository's changes to the chat.",
    `mkdir -p ${q(HOOK_DIR)} /home/sprite/.claude`,
    `cat > ${q(HOOK_SCRIPT)} <<'SALON_HOOK'`,
    hookScript(o),
    "SALON_HOOK",
    `chmod 755 ${q(HOOK_SCRIPT)}`,
    `cat > ${q(LOCAL_SETTINGS)} <<'SALON_SETTINGS'`,
    JSON.stringify(localSettings(), null, 2),
    "SALON_SETTINGS",
    "",
  ].join("\n");
}

/** The hook settings Claude Code reads: which events run the script, and why it says it ran. */
export function localSettings(): Record<string, unknown> {
  const run = (reason: string) => ({ hooks: [{ type: "command", command: `${HOOK_SCRIPT} ${reason}`, timeout: 60 }] });
  return {
    hooks: {
      SessionStart: [run("session")],
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", ...run("tool") }],
      Stop: [run("stop")],
    },
  };
}

/**
 * The hook itself. Runs inside the computer as a child of the runtime, so it
 * holds the conversation's own key and id in its environment. On a session's
 * first run it moves the checkout off the base onto the chat's own branch;
 * every run then posts the branch, the head, `git status` and one diff of
 * the working tree against the merge base with the base branch, untracked
 * files as additions. Tool runs are held to one post every two seconds.
 * It never fails the turn: every path ends in exit 0.
 */
export function hookScript(o: HookOptions): string {
  return `#!/usr/bin/env bash
# Salon changes hook. Written by the project's setup script; do not edit here.
set -u
REPO=${q(o.repoPath)}
BASE=${q(o.base)}
URL=${q(`${o.publicUrl}/hooks/changes`)}
REASON="\${1:-manual}"
[ -n "\${FOUNTAIN_TOKEN:-}" ] || exit 0
[ -n "\${FOUNTAIN_CONVERSATION_ID:-}" ] || exit 0
cd "$REPO" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
STAMP="/tmp/salon-changes.$FOUNTAIN_CONVERSATION_ID"
if [ "$REASON" = tool ] && [ -f "$STAMP" ]; then
  NOW=$(date +%s); THEN=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)
  [ $((NOW - THEN)) -ge 2 ] || exit 0
fi
touch "$STAMP"
if [ "$REASON" = session ]; then
  CUR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$CUR" = "$BASE" ] || [ "$CUR" = HEAD ]; then
    git checkout -q -B "salon/\${FOUNTAIN_CONVERSATION_ID:0:8}" 2>/dev/null || true
  fi
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
MB=$(git merge-base "origin/$BASE" HEAD 2>/dev/null || echo "$HEAD_SHA")
# The diff and the status go through files: one shell argument is capped at 128 KB on Linux, and a diff is bigger.
WORK=$(mktemp -d /tmp/salon-changes.XXXXXX) || exit 0
trap 'rm -rf "$WORK"' EXIT
git status --porcelain=v1 > "$WORK/status" 2>/dev/null || : > "$WORK/status"
: > "$WORK/diff"
if [ -n "$MB" ]; then git diff "$MB" -- . >> "$WORK/diff" 2>/dev/null || true; fi
while IFS= read -r f; do
  [ -n "$f" ] || continue
  git diff --no-index -- /dev/null "$f" >> "$WORK/diff" 2>/dev/null || true
done < <(git ls-files --others --exclude-standard 2>/dev/null)
head -c ${DIFF_CAP} "$WORK/diff" > "$WORK/diff.cut" && mv "$WORK/diff.cut" "$WORK/diff"
AHEAD=null
if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then AHEAD=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo null); fi
PR=null
if command -v gh >/dev/null 2>&1 && [ -n "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}" ]; then
  PR=$(GH_TOKEN="\${GH_TOKEN:-$GITHUB_TOKEN}" gh pr view --json url,state,mergeable 2>/dev/null || echo null)
  [ -n "$PR" ] || PR=null
fi
jq -n --arg branch "$BRANCH" --arg head "$HEAD_SHA" --arg base "$BASE" --arg reason "$REASON" --argjson pr "$PR" --argjson ahead "$AHEAD" \\
  --rawfile status "$WORK/status" --rawfile diff "$WORK/diff" \\
  '{branch:$branch, head:$head, base:$base, status:$status, diff:$diff, reason:$reason, pr:$pr, ahead:$ahead}' > "$WORK/body" 2>/dev/null || exit 0
curl -sS -m 30 -X POST "$URL" \\
    -H "Authorization: Bearer $FOUNTAIN_TOKEN" \\
    -H "X-Fountain-Conversation-Id: $FOUNTAIN_CONVERSATION_ID" \\
    -H 'Content-Type: application/json' \\
    --data-binary "@$WORK/body" >/dev/null 2>&1 || true
exit 0
`;
}

/** One more than the server keeps, so the server can tell "cut" from "exactly full". */
const DIFF_CAP = 1_000_001;

/** A string as one shell word, single-quoted. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
