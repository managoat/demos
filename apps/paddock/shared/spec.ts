/**
 * The prompt contract: what paddock asks the box to do, and how the box
 * reports back. Per-app on purpose — this and `protocol.ts` are the two files
 * the suite never shares, because they *are* the product.
 *
 * The whole design follows from one fact about Fountain: there is no way to
 * run a command on a machine from outside. Reads are free (`/api/sandboxes/…`)
 * but every *write* to the box is a turn taken by the agent living on it. So
 * "apply this to the machine" is a prompt, and "what is on the machine" is a
 * file the agent leaves behind.
 *
 * That file is the receipt. Paddock computes the ids of everything it wants on
 * the box (`lib/machine.ts` — `pkg:ripgrep`, `repo:…`, `setup:…`, `skill:…`),
 * hands the agent the exact strings, and asks it to write back the ones it
 * actually got done. Paddock never asks the box to *derive* an id: copying a
 * string is something a model does reliably, and deriving a hash is not.
 */

/** Paddock's corner of the box. Claude Code's home; codex shares it. */
export const PADDOCK_DIR = "/home/sprite/.paddock";

/** What the box says is on it. Read with `GET /api/sandboxes/:id/file`. */
export const RECEIPT_PATH = `${PADDOCK_DIR}/applied.json`;

/** Where a tab's working directory lives. One directory per tab, under here. */
export const WORK_ROOT = "/home/sprite/work";

/** The system prompt for the one agent that lives on the box. */
export function systemPrompt(): string {
  return [
    "You are the agent on someone's personal cloud machine, reached through Paddock.",
    "",
    "The machine persists. Several terminal tabs talk to you, each in its own working",
    "directory under " + WORK_ROOT + ", and only one of them can hold a turn at a time.",
    "Work in the directory the tab tells you to work in and do not wander into another",
    "tab's directory unless you are asked to.",
    "",
    "Some turns come from Paddock itself rather than from a person. Those always say so,",
    "and they ask you to change the machine and then write " + RECEIPT_PATH + ".",
    "Follow their instructions exactly, including the strings they give you to write back:",
    "Paddock compares that file against what it asked for, and an id you invented or",
    "reworded reads as work that did not happen.",
    "",
    "Otherwise you are an ordinary coding agent. Be concise; this is a terminal.",
  ].join("\n");
}

/**
 * A tab's first turn: make the working directory and say where you are.
 *
 * A repository already cloned by the environment gets a real `git worktree`,
 * which is what makes two tabs on one box able to hold different branches at
 * once. Everything else gets a plain directory. The tab is not usable until
 * this lands, so it is sent the moment the tab opens.
 */
export function bootstrapPrompt(input: { slug: string; repoPath: string | null }): string {
  const dir = `${WORK_ROOT}/${input.slug}`;
  const lines = [
    "[paddock] New terminal tab. Set up its working directory, then stop.",
    "",
    `mkdir -p ${WORK_ROOT}`,
  ];
  if (input.repoPath) {
    lines.push(
      "",
      `This box has a repository at ${input.repoPath}. Give this tab its own worktree so it`,
      "can hold a branch without disturbing the other tabs:",
      "",
      `  cd ${input.repoPath}`,
      `  git worktree add ${dir} -b paddock/${input.slug} 2>/dev/null || git worktree add ${dir}`,
      "",
      `If the worktree cannot be made (no commits yet, or the path is taken), fall back to`,
      `\`mkdir -p ${dir}\` and say so in one line.`,
    );
  } else {
    lines.push("", `mkdir -p ${dir}`);
  }
  lines.push(
    "",
    `Then \`cd ${dir}\`, and reply with exactly one line: the working directory and, if it is`,
    "a worktree, the branch. No preamble, no summary, no next steps.",
  );
  return lines.join("\n");
}

/**
 * The very first turn on a brand-new machine.
 *
 * It does the same setup as `bootstrapPrompt` — a tab is useless without a
 * working directory — and then introduces the place, because this turn is the
 * only one a person watches with no idea what they are looking at. Every tab
 * after this gets the terse version: an orientation lecture on every new tab
 * would be noise.
 *
 * It is deliberately a real turn rather than static copy in the UI. The first
 * thing a new arrival sees is the agent actually working on their machine, in
 * the scrollback, which is the whole product — and it says what is true of
 * *this* box (whether it has a repository, where it put things) rather than
 * what is true of a screenshot.
 */
export function welcomePrompt(input: { slug: string; repoPath: string | null }): string {
  return [
    bootstrapPrompt(input),
    "",
    "Then, because this is the person's first look at their machine, introduce it.",
    "Keep it short — a terminal, not a brochure. Cover, in your own words:",
    "",
    "  - this machine is theirs and it persists; it is here next time",
    "  - a new tab is another session on this same box, with its own directory",
    "  - only one tab runs a turn at a time, because there is one machine",
    "  - the Machine panel is where repositories, packages, a setup script,",
    "    secrets, MCP servers and skills go, and nothing there reaches the box",
    "    until it is applied — which is a turn they will watch happen here",
    "  - People is how someone else gets in, by email or by a link that needs",
    "    no account; anyone let in can read this machine",
    "",
    "Then suggest one concrete thing to try, and stop. No headings, no bullet",
    "list longer than the one above, no offer to explain further.",
  ].join("\n");
}

/** One thing paddock wants on the box, as the apply turn is told about it. */
export interface ApplyItem {
  /** The canonical id (`pkg:ripgrep`) — copied verbatim into the receipt. */
  id: string;
  /** The imperative, in English: "install the apt package `ripgrep`". */
  instruction: string;
}

/**
 * The apply turn. Paddock sends this to the ops tab; the person watches it run.
 *
 * `keep` is everything already on the box that is still wanted — it goes into
 * the receipt untouched so a partial apply never looks like a regression. The
 * agent is told to write the receipt even when some items fail, because a
 * receipt that omits a failure is worse than one that reports it: the panel
 * can show "3 of 4 applied" only if the box says so.
 */
export function applyPrompt(input: { rev: number; todo: ApplyItem[]; keep: string[]; runtime: string }): string {
  const lines = [
    "[paddock] Apply these changes to this machine, then write the receipt.",
    "",
    "Do each of these, in order. They are ordinary shell work; use sudo where a package",
    "install needs it. If one fails, keep going with the rest.",
    "",
  ];
  input.todo.forEach((item, i) => {
    lines.push(`  ${i + 1}. ${item.instruction}`);
    lines.push(`     id: ${item.id}`);
  });
  lines.push(
    "",
    `Then write ${RECEIPT_PATH} (mkdir -p ${PADDOCK_DIR} first). It is JSON, exactly this shape:`,
    "",
    "  {",
    `    "rev": ${input.rev},`,
    `    "runtime": ${JSON.stringify(input.runtime)},`,
    '    "applied_at": "<ISO 8601 UTC, now>",',
    '    "items": ["<id>", "…"],',
    '    "failed": [{"id": "<id>", "why": "<one short line>"}]',
    "  }",
    "",
    '"items" must contain every id below that is now genuinely on this machine, copied',
    "character for character from this message — do not reword, reorder the parts, or",
    "invent ids. Start from these, which are already on the box and still wanted:",
    "",
  );
  lines.push(input.keep.length ? input.keep.map((id) => `  ${id}`).join("\n") : "  (none — this is the first apply)");
  lines.push(
    "",
    "and add the ids from the numbered list above that you completed. Put the ones that",
    'did not work in "failed" instead, with a short reason. Never put an id in both.',
    "",
    "Then reply with one line per item: the id and whether it landed. Nothing else.",
  );
  return lines.join("\n");
}

/**
 * The turn that re-reads the machine when the receipt is missing or unreadable
 * — after a rebuild, or the first time an older box meets this app. It asks
 * for the receipt to be written from what is actually installed, rather than
 * assuming an empty box and reinstalling the world.
 */
export function reconcilePrompt(input: { rev: number; candidates: ApplyItem[]; runtime: string }): string {
  return [
    "[paddock] This machine has no readable receipt. Work out what is already here.",
    "",
    "Check each of these and decide whether it is genuinely present already. Do not",
    "install anything — this turn only looks.",
    "",
    ...input.candidates.flatMap((c, i) => [`  ${i + 1}. ${c.instruction}`, `     id: ${c.id}`]),
    "",
    `Then write ${RECEIPT_PATH} (mkdir -p ${PADDOCK_DIR} first) with the same shape paddock`,
    "always uses:",
    "",
    "  {",
    `    "rev": ${input.rev},`,
    `    "runtime": ${JSON.stringify(input.runtime)},`,
    '    "applied_at": "<ISO 8601 UTC, now>",',
    '    "items": ["<id of each one that is already present>"],',
    '    "failed": []',
    "  }",
    "",
    "Copy the ids character for character. Reply with one line per item.",
  ].join("\n");
}
