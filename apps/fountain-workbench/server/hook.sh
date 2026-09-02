#!/usr/bin/env bash
# The workbench's snapshot hook, installed into a sandbox by its environment's
# setup script:
#
#   curl -fsSL __WORKBENCH_URL__/hook/install.sh | bash
#
# It writes three things and touches nothing else:
#
#   /home/sprite/.workbench/snapshot.sh          reads git state, POSTs it to the workbench
#   /home/sprite/.workbench/git-hooks/post-commit  runs it after every commit (global core.hooksPath)
#   /home/sprite/.claude/settings.local.json     runs it on Claude Code's Stop and PostToolUse
#
# The snapshot is *state*, not bytes: branch, head, upstream, ahead/behind and
# porcelain status. The diff itself is read by the workbench through Fountain
# (`GET /api/sandboxes/:id/diff`, ADR 0039), which redacts the sandbox's
# secrets on the way out; a hook posting raw diffs would not. What the hook
# adds is what that read cannot tell: which branch, how far ahead, which
# files are untracked, and *when* something changed.
#
# Why these paths (server/hook.ts has the long form): Fountain rewrites
# ~/.claude/settings.json after the setup script whenever the agent has an
# MCP server, and claude's cwd is its HOME, so the hook lives in
# settings.local.json. The identity it authenticates with — $FOUNTAIN_TOKEN
# and $FOUNTAIN_CONVERSATION_ID — is spawn env on the agent's process, which a
# hook inherits and a daemon started here would not.
set -euo pipefail
mkdir -p /home/sprite/.workbench/git-hooks /home/sprite/.claude

cat > /home/sprite/.workbench/snapshot.sh <<'SNAPSHOT'
#!/usr/bin/env bash
# Post the git state of every checkout to the workbench. Runs as a Claude
# Code hook (Stop, PostToolUse) and as the git post-commit hook. Never fails
# the caller: every exit is 0, and everything it has to say goes to the log.
set -u
SOURCE="${1:-manual}"
DIR=/home/sprite/.workbench
LOG="$DIR/log"
exec >>"$LOG" 2>&1
echo "== $(date -u +%FT%TZ) source=$SOURCE pid=$$"

# A Claude Code hook gets JSON on stdin; a git hook gets nothing. Read it if
# it is there, never wait for it.
INPUT=""
if [ ! -t 0 ]; then INPUT="$(timeout 2 cat 2>/dev/null || true)"; fi
EVENT="$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)"

URL="${WORKBENCH_URL:-__WORKBENCH_URL__}"
if [ -z "${FOUNTAIN_TOKEN:-}" ] || [ -z "${FOUNTAIN_CONVERSATION_ID:-}" ]; then
  echo "no conversation identity in this process ($(env | grep -oE '^FOUNTAIN_[A-Z_]+' | tr '\n' ' ')); giving up"
  exit 0
fi

# An agent editing five files in a row is one snapshot, not five.
if [ "$SOURCE" = post-tool ]; then
  STAMP="$DIR/last-post-tool"
  if [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -c %Y "$STAMP") )) -lt 5 ]; then echo throttled; exit 0; fi
  touch "$STAMP"
fi

# The checkouts: named, or every repository under the two places environments mount them.
REPOS="${WORKBENCH_REPOS:-}"
if [ -z "$REPOS" ]; then
  for d in /home/sprite/work/* /workspace/*; do [ -d "$d/.git" ] && REPOS="$REPOS $d"; done
fi

for REPO in $REPOS; do
  [ -d "$REPO/.git" ] || continue
  cd "$REPO" || continue
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
  UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  AHEAD=0; BEHIND=0
  if [ -n "$UPSTREAM" ]; then
    COUNTS="$(git rev-list --left-right --count "$UPSTREAM...HEAD" 2>/dev/null || printf '0\t0')"
    BEHIND="${COUNTS%%[[:space:]]*}"; AHEAD="${COUNTS##*[[:space:]]}"
  fi
  AHEAD="${AHEAD:-0}"; BEHIND="${BEHIND:-0}"
  T="$(mktemp -d)"
  git status --porcelain=v2 --branch --untracked-files=all 2>/dev/null | head -c 65536 > "$T/status" || true
  jq -n --arg repo "$REPO" --arg source "$SOURCE" --arg branch "$BRANCH" --arg head "$HEAD_SHA" --arg upstream "$UPSTREAM" \
    --argjson ahead "$AHEAD" --argjson behind "$BEHIND" --rawfile status "$T/status" --arg event "$EVENT" --arg tool "$TOOL" \
    '{repo:$repo, source:$source, branch:$branch, head:$head, upstream:$upstream, ahead:$ahead, behind:$behind, status:$status, meta:{event:$event, tool:$tool}}' > "$T/body.json"
  CODE="$(curl -sS -m 20 -o "$T/resp" -w '%{http_code}' -X POST "$URL/api/snapshots" \
    -H "authorization: Bearer $FOUNTAIN_TOKEN" -H "x-fountain-conversation-id: $FOUNTAIN_CONVERSATION_ID" \
    -H 'content-type: application/json' --data-binary @"$T/body.json" || echo curl-failed)"
  echo "$REPO -> $CODE $(head -c 200 "$T/resp" 2>/dev/null || true)"
  rm -rf "$T"
done
exit 0
SNAPSHOT
chmod +x /home/sprite/.workbench/snapshot.sh

# The git half: one hooks directory for every checkout on the machine,
# including one the agent clones later.
cat > /home/sprite/.workbench/git-hooks/post-commit <<'HOOK'
#!/bin/sh
exec /home/sprite/.workbench/snapshot.sh post-commit </dev/null
HOOK
chmod +x /home/sprite/.workbench/git-hooks/post-commit
git config --global core.hooksPath /home/sprite/.workbench/git-hooks

# The Claude Code half. Local scope on purpose: see the header.
cat > /home/sprite/.claude/settings.local.json <<'SETTINGS'
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "/home/sprite/.workbench/snapshot.sh post-tool", "timeout": 60 }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "/home/sprite/.workbench/snapshot.sh stop", "timeout": 60 }]
      }
    ]
  }
}
SETTINGS

command -v jq >/dev/null 2>&1 || echo "workbench hook: jq is not installed; add it to the environment's apt packages or the hook will post nothing" >&2
echo "workbench hook installed (posts to __WORKBENCH_URL__)"
