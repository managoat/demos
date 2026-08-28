/**
 * The apps served under demo.managoat.com, one entry each.
 *
 * The host and the source repository are not stored: both are derived from
 * `id`, because both are the id by construction — the app answers on
 * `<id>.demo.managoat.com` and its code is at `github.com/managoat/<id>`. A
 * field that can only ever hold one value is a field that can hold a wrong
 * one.
 *
 * This is the second list of these apps. The first is `built_apps/0` in
 * BinaryBourbon/fountain, which renders managoat.com/built-with, and the two
 * disagreeing is the exact failure that retired the previous version of this
 * page — it ended three apps behind. The copy below is lifted from that list
 * verbatim so the wording matches, and `.github/workflows/ci.yml` fetches
 * built-with on every run and fails if the two rosters name different apps.
 * Drift is now a red build rather than something a reader notices.
 */
export type Demo = {
  id: string;
  glyph: string;
  name: string;
  blurb: string;
};

export const DEMOS: readonly Demo[] = [
  {
    id: "fountain-conversations",
    glyph: "🧵",
    name: "Conversations",
    blurb:
      "Start a run, watch the agent work turn by turn, and drive it. Chat, timeline and raw views of the same conversation, plus the machine it shares with its siblings.",
  },
  {
    id: "fountain-team",
    glyph: "👥",
    name: "Team",
    blurb:
      "Your agents as teammates in a messaging app. Roster on the left, thread on the right, routines on a schedule, images and search. Enter to send.",
  },
  {
    id: "fountain-workbench",
    glyph: "🧰",
    name: "Workbench",
    blurb:
      "A dev workstation the team shares. A project is an environment and a vault, work items live in it, and putting a teammate on one is a first prompt rather than four steps of setup.",
  },
  {
    id: "briefing-room",
    glyph: "📰",
    name: "Briefing Room",
    blurb:
      "Say what you need to understand and why. A researcher with its own computer reads real sources and hands back a clean, cited brief. A document, not a chat.",
  },
  {
    id: "table-talk",
    glyph: "📊",
    name: "Table Talk",
    blurb:
      "Drop a CSV in. An analyst runs Python on its sandbox and comes back with charts and plain-English findings. Then keep asking questions of your data.",
  },
  {
    id: "repo-sage",
    glyph: "🌿",
    name: "Repo Sage",
    blurb:
      "Name any public GitHub repository. An agent clones it on its own machine and answers with file-and-line citations that link back to the source.",
  },
  {
    id: "mission-control",
    glyph: "🚀",
    name: "Mission Control",
    blurb:
      "Describe a mission. A coordinator plans it, you approve the plan, and the app starts one sandboxed agent per task. Watch the fleet work and take one report.",
  },
  {
    id: "dns-desk",
    glyph: "🗂️",
    name: "DNS Desk",
    blurb:
      "A DNS operator for your Cloudflare zones. Ask in plain words, read the plan as a diff, approve. The zone tables stay on screen while the agent does the work.",
  },
  {
    id: "watchtower",
    glyph: "🗼",
    name: "Watchtower",
    blurb:
      "An SRE teammate on a cron: uptime, latency, TLS expiry and DNS for every site you name. When a tile turns red, ask it to investigate. It has real tools.",
  },
  {
    id: "mend",
    glyph: "🔦",
    name: "Mend",
    blurb:
      "What an audit finds across a repository's CI, manifests, Dockerfiles and cloud templates, and what an agent does once you hand it that tool. Mechanical fixes applied, judgement calls argued, one patch back.",
  },
  {
    id: "rounds",
    glyph: "🔁",
    name: "Rounds",
    blurb:
      "Dependabot for infrastructure config. Enrol a repository and it gets audited on a schedule; an agent fixes what it can verify and opens the pull request. Never twice for the same finding, never again for one you closed.",
  },
  {
    id: "arena",
    glyph: "🥊",
    name: "Arena",
    blurb:
      "One prompt, several brains, side by side. Blind columns, live streams, latency and token counts, and your vote on the scoreboard.",
  },
];

export const host = (d: Demo) => `${d.id}.demo.managoat.com`;
export const url = (d: Demo) => `https://${host(d)}/`;
export const source = (d: Demo) => `https://github.com/managoat/${d.id}`;
