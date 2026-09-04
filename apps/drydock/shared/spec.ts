/**
 * The prompt contract: what drydock asks a machine to do, and how the
 * machine answers. Per-app on purpose — this and `protocol.ts` are the two
 * files the demo suite never shares, because they *are* the product.
 *
 * Drydock's shape follows from one sentence in Fountain's API reference:
 * *there is no request that runs a command; to run a command, send a prompt.*
 * Everything a project needs done to a machine is therefore either a turn or
 * a property of the environment the machine was built from — and drydock
 * uses each for the half it is good at.
 *
 * **The environment builds the disk.** A project's repository is a
 * `repositories[]` entry on its environment, so every machine that environment
 * ever builds arrives with the clone already on it. Nothing has to ask for
 * that, and nothing can forget to.
 *
 * **A turn cuts the branch.** Which branch a thread is on is a fact about that
 * thread and not about the project, so it cannot live in the environment. It
 * is the first turn of the conversation, and it is the only turn drydock
 * writes for you.
 *
 * The reason this is one short turn rather than a paragraph of etiquette is the
 * model underneath: **a thread owns its whole machine.** Paddock had to spend
 * a system prompt telling an agent not to touch the other tabs' work, because
 * paddock's tabs share one disk. Here they do not share anything — every
 * thread's conversation is `sandbox_mode: "ephemeral"`, so Fountain builds it
 * a machine of its own from the project's environment and reclaims it when the
 * thread ends. There is no other thread's work on the disk to protect, and a
 * rule nobody can break is better than a rule stated three times.
 */
import { STATE_DIR, HOME } from "./ids";

/** What the machine writes to say what it did. Read with `GET /api/sandboxes/:id/file`. */
export const RECEIPT_PATH = `${STATE_DIR}/thread.json`;

/** Where a thread starts a branch from, and why it is called that. */
export type Origin =
  | { kind: "branch"; base: string }
  | { kind: "pr"; base: string; number: number; title: string }
  | { kind: "issue"; base: string; number: number; title: string }
  | { kind: "blank" };

/**
 * The system prompt for a project's agent.
 *
 * Short, because the isolation it would otherwise have to argue for is
 * structural. What is left is the two things an agent genuinely cannot work
 * out from the disk: which branch this thread is meant to be on, and that
 * pushing is expected rather than presumptuous.
 */
export function systemPrompt(input: { project: string; repo: string | null; repoPath: string | null; instructions: string }): string {
  const lines = [
    `You are the coding agent on a drydock machine for the project "${input.project}".`,
    "",
    "This machine is yours alone. It was built for one thread of work and it is",
    "reclaimed when that thread ends, so there is nobody else's checkout on it and",
    "nothing here to be careful around. Work directly.",
    "",
  ];
  if (input.repo && input.repoPath) {
    lines.push(
      `The repository ${input.repo} is cloned at ${input.repoPath}. That is your working`,
      "directory. The thread's first turn puts you on the branch this work belongs on;",
      "stay on it, and commit as you go rather than leaving everything for the end —",
      "the person watching sees your commits and your diff, not your intentions.",
      "",
      "Push when you have something worth showing. `git push -u origin HEAD` works: the",
      "clone's remote already carries credentials, so you never need a token and should",
      "never ask for one. Do not open a pull request yourself unless you are asked to —",
      "drydock has a button for that and two PRs for one branch is a mess.",
      "",
    );
  } else {
    lines.push(
      `There is no repository on this machine. ${HOME} is yours; make something there.`,
      "",
    );
  }
  lines.push(
    "Keep replies short. The person reading them has your diff open beside them.",
  );
  if (input.instructions.trim()) {
    lines.push("", "## From the project's owner", "", input.instructions.trim());
  }
  return lines.join("\n");
}

/**
 * The one turn drydock writes: put this thread on its branch, then say so.
 *
 * It is a script rather than a description because the answer has to be
 * *exact* — the panel above the transcript reads the receipt and renders it as
 * fact, and "created the branch" from an agent that did not quite is the one
 * lie the app cannot survive. A shell script either ran or it did not.
 *
 * `set -e` is deliberately absent. Every step that can fail here fails
 * *acceptably*: a `git fetch` on a machine with no network still leaves a
 * usable checkout, and an issue whose base branch was deleted should land the
 * thread on the default branch rather than leaving it on nothing. The receipt
 * records what actually happened, so a partial success is legible rather than
 * silent.
 */
export function bootstrapPrompt(input: {
  repo: string | null;
  repoPath: string | null;
  branch: string;
  origin: Origin;
  /** The commit or ref to start from. Null for a blank machine. */
  base: string | null;
}): string {
  if (!input.repo || !input.repoPath) {
    return [
      "Run exactly this, then reply with one short sentence saying the machine is ready.",
      "",
      "```bash",
      `mkdir -p ${STATE_DIR}`,
      `cat > ${RECEIPT_PATH} <<'JSON'`,
      JSON.stringify({ repo: null, path: HOME, branch: null, base: null, files: null }, null, 2),
      "JSON",
      "```",
    ].join("\n");
  }

  const base = input.base ?? "HEAD";
  // A PR thread checks out the PR's own head so the work continues where it is,
  // rather than branching beside it and re-doing it. Every other origin cuts a
  // fresh branch from a base ref.
  const checkout =
    input.origin.kind === "pr"
      ? [
          `git fetch origin "pull/${input.origin.number}/head:${input.branch}" 2>/dev/null || git fetch origin "${base}" 2>/dev/null || true`,
          `git checkout "${input.branch}" 2>/dev/null || git checkout -b "${input.branch}" "origin/${base}" 2>/dev/null || git checkout -b "${input.branch}"`,
        ]
      : [
          `git fetch origin "${base}" 2>/dev/null || true`,
          `git checkout -b "${input.branch}" "origin/${base}" 2>/dev/null || git checkout -b "${input.branch}" "${base}" 2>/dev/null || git checkout -b "${input.branch}"`,
        ];

  return [
    "Run exactly this, then reply with one short sentence naming the branch you are on.",
    "Do not do anything else yet.",
    "",
    "```bash",
    `cd ${input.repoPath}`,
    ...checkout,
    `mkdir -p ${STATE_DIR}`,
    // Written with the shell's own answers rather than the agent's recollection
    // of them. `git rev-parse` cannot be optimistic.
    `cat > ${RECEIPT_PATH} <<JSON`,
    "{",
    `  "repo": "${input.repo}",`,
    `  "path": "${input.repoPath}",`,
    '  "branch": "$(git rev-parse --abbrev-ref HEAD)",',
    `  "base": "${base}",`,
    '  "sha": "$(git rev-parse --short HEAD)",',
    '  "files": $(git ls-files | wc -l | tr -d " ")',
    "}",
    "JSON",
    "```",
  ].join("\n");
}

/** What `RECEIPT_PATH` holds once the first turn has run. */
export interface Receipt {
  repo: string | null;
  path: string;
  branch: string | null;
  base: string | null;
  sha?: string | null;
  files: number | null;
}

/**
 * Read a receipt, or decide that there is not one yet.
 *
 * An unreadable receipt is *not* a failed thread — it is a thread whose first
 * turn has not finished, which is the normal state for the first thirty
 * seconds of every thread there has ever been. The caller renders "setting
 * up", never an error.
 */
export function parseReceipt(text: string): Receipt | null {
  try {
    const raw = JSON.parse(text) as Partial<Receipt>;
    if (typeof raw.path !== "string") return null;
    return {
      repo: typeof raw.repo === "string" ? raw.repo : null,
      path: raw.path,
      branch: typeof raw.branch === "string" && raw.branch !== "HEAD" ? raw.branch : null,
      base: typeof raw.base === "string" ? raw.base : null,
      sha: typeof raw.sha === "string" ? raw.sha : null,
      files: typeof raw.files === "number" && Number.isFinite(raw.files) ? raw.files : null,
    };
  } catch {
    return null;
  }
}

/**
 * The suggestion chips under an empty transcript.
 *
 * Conductor's are generic; these are not, because a drydock thread already
 * knows what it was opened from. A thread cut from issue #412 should not be
 * offering "Fix a TODO".
 */
export function starters(origin: Origin, repo: string | null): { label: string; prompt: string }[] {
  if (origin.kind === "issue") {
    return [
      { label: `Work on #${origin.number}`, prompt: `Read issue #${origin.number} ("${origin.title}") and implement it. Show me your plan before you write code.` },
      { label: "Reproduce it first", prompt: `Before changing anything, reproduce what issue #${origin.number} describes and tell me what you found.` },
    ];
  }
  if (origin.kind === "pr") {
    return [
      { label: `Review #${origin.number}`, prompt: `Review this pull request's own diff against its base and tell me what is wrong with it.` },
      { label: "Address the comments", prompt: `Read the review comments on #${origin.number} and address them.` },
      { label: "Rebase on the base branch", prompt: `Rebase this branch on ${origin.base} and resolve any conflicts.` },
    ];
  }
  const base = repo ? [] : [{ label: "Show me around", prompt: "What is on this machine, and what can I do with it?" }];
  return [
    ...base,
    ...(repo
      ? [
          { label: "Explain this repo", prompt: "Give me the two-minute tour of this repository: what it is, how it is laid out, and where the interesting code is." },
          { label: "Run the tests", prompt: "Work out how this project runs its tests, run them, and tell me the state of things." },
          { label: "Fix a TODO", prompt: "Find a TODO or FIXME worth doing, do it, and commit it." },
        ]
      : []),
  ];
}
