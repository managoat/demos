import { describe, expect, test } from "bun:test";
import { arrangeRound, clusterCounts, describeRound, foldRounds, openPullRequests, parseRounds } from "./protocol";

const round = (body: string) => `Did a round.\n\n\`\`\`round\n${body}\n\`\`\``;

const FULL = round(`{"at":"2026-08-20T09:00:00Z","commit":"9f1c4a2","branch":"main","scanned":14,
 "summary":{"total":9,"quickWin":3,"needsReview":4,"reportOnly":2},
 "clusters":[
  {"key":"github-workflows-ci-yml","file":".github/workflows/ci.yml","status":"opened","pr":41,"url":"https://github.com/o/r/pull/41","checkIds":["GHA033"],"title":"ci: harden workflow permissions"},
  {"key":"dockerfile","file":"Dockerfile","status":"already-open","pr":38,"url":"https://github.com/o/r/pull/38","checkIds":["DKRD012"]},
  {"key":"k8s-deployment-yaml","file":"k8s/deployment.yaml","status":"declined","pr":31,"checkIds":["WK8110"]}],
 "openPrs":2,"error":null}`);

describe("parseRounds", () => {
  test("reads a round out of a reply that has prose around it", () => {
    const [r] = parseRounds(FULL);
    expect(r!.commit).toBe("9f1c4a2");
    expect(r!.summary.quickWin).toBe(3);
    expect(r!.clusters).toHaveLength(3);
    expect(r!.openPrs).toBe(2);
  });

  test("keeps every cluster status, including the ones with no action", () => {
    const [r] = parseRounds(FULL);
    expect(r!.clusters.map((c) => c.status)).toEqual(["opened", "already-open", "declined"]);
    expect(r!.clusters[0]!.url).toBe("https://github.com/o/r/pull/41");
  });

  test("an unknown status degrades rather than vanishing", () => {
    const [r] = parseRounds(round('{"summary":{},"clusters":[{"key":"a","file":"a.yml","status":"YOLO"}]}'));
    expect(r!.clusters[0]!.status).toBe("clean");
  });

  test("openPrs is recomputed when the agent omits it", () => {
    const [r] = parseRounds(round('{"summary":{},"clusters":[{"key":"a","file":"a","status":"opened","pr":1},{"key":"b","file":"b","status":"declined"}]}'));
    expect(r!.openPrs).toBe(1);
  });

  test("a non-https pr url is dropped", () => {
    const [r] = parseRounds(round('{"summary":{},"clusters":[{"key":"a","file":"a","status":"opened","url":"javascript:alert(1)"}]}'));
    expect(r!.clusters[0]!.url).toBeUndefined();
  });

  test("malformed or empty blocks are skipped", () => {
    expect(parseRounds("```round\n{not json\n```")).toEqual([]);
    expect(parseRounds("```round\n{}\n```")).toEqual([]);
    expect(parseRounds("no block here")).toEqual([]);
  });

  test("an error round survives even with nothing else in it", () => {
    const [r] = parseRounds(round('{"error":"repository is private","clusters":[],"summary":{}}'));
    expect(r!.error).toBe("repository is private");
  });
});

describe("foldRounds", () => {
  test("newest first, carrying Fountain's own timestamp", () => {
    const entries = foldRounds([
      { reply: round('{"summary":{"total":1},"clusters":[],"openPrs":0}'), ranAt: "2026-08-13T09:00:00Z" },
      { reply: FULL, ranAt: "2026-08-20T09:00:00Z" },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.ranAt).toBe("2026-08-20T09:00:00Z");
    expect(entries[0]!.round.clusters).toHaveLength(3);
  });

  test("turns with no round block contribute nothing", () => {
    expect(foldRounds([{ reply: "just chatting" }])).toEqual([]);
  });
});

describe("openPullRequests", () => {
  test("only the newest round's live PRs, deduped", () => {
    const prs = openPullRequests(foldRounds([{ reply: FULL }]));
    expect(prs.map((c) => c.pr)).toEqual([41, 38]);
  });

  test("declined and failed clusters are not pull requests you have open", () => {
    const prs = openPullRequests(foldRounds([{ reply: round('{"summary":{},"clusters":[{"key":"a","file":"a","status":"declined","pr":3},{"key":"b","file":"b","status":"failed"}]}') }]));
    expect(prs).toEqual([]);
  });

  test("no rounds, no pull requests", () => {
    expect(openPullRequests([])).toEqual([]);
  });
});

describe("describeRound", () => {
  test("leads with what it opened", () => {
    expect(describeRound(parseRounds(FULL)[0]!)).toContain("opened 1 pull request");
  });

  test("a clean repo and a quiet round read differently", () => {
    expect(describeRound(parseRounds(round('{"summary":{"total":0},"clusters":[],"openPrs":0}'))[0]!)).toBe("clean — nothing to fix");
    expect(describeRound(parseRounds(round('{"summary":{"total":4},"clusters":[],"openPrs":0}'))[0]!)).toBe("nothing new to propose");
  });

  test("an error is the whole story", () => {
    expect(describeRound(parseRounds(round('{"error":"no push access","summary":{},"clusters":[]}'))[0]!)).toBe("no push access");
  });
});

// ── the findings and the diffs ──────────────────────────────────────────────

const REPORTED = `Did a round.

\`\`\`round
{"summary":{"total":3,"quickWin":1,"needsReview":1,"reportOnly":1},
 "findings":[
  {"checkId":"GHA033","severity":"error","message":"no permissions block","file":".github/workflows/ci.yml",
   "entity":"jobs.build","tier":"merge-worthy","fixKind":"deterministic","category":"security",
   "title":"Workflow permissions are not restricted","note":"Added permissions: contents: read."},
  {"checkId":"DKRD003","severity":"warning","message":"runs as root","file":"Dockerfile",
   "tier":"merge-worthy","fixKind":"guidance","category":"security","title":"Container runs as root"},
  {"checkId":"WHM021","severity":"info","message":"no resource limits","file":"charts/web/values.yaml",
   "tier":"report-only","fixKind":"guidance","category":"best-practice","title":"No resource limits"}],
 "clusters":[
  {"key":"github-workflows-ci-yml","file":".github/workflows/ci.yml","status":"opened","pr":41,"checkIds":["GHA033"]},
  {"key":"dockerfile","file":"Dockerfile","status":"deferred","checkIds":["DKRD003"]}],
 "openPrs":1,"error":null}
\`\`\`

\`\`\`round-diff github-workflows-ci-yml
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 1a2b3c4..5d6e7f8 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -12,6 +12,8 @@ jobs:
   build:
+    permissions:
+      contents: read
     steps:
\`\`\``;

describe("findings", () => {
  test("come back off the round, report-only tier included", () => {
    const [r] = parseRounds(REPORTED);
    expect(r!.findings).toHaveLength(3);
    expect(r!.findings[0]!.checkId).toBe("GHA033");
    expect(r!.findings[0]!.note).toBe("Added permissions: contents: read.");
    expect(r!.findings[2]!.tier).toBe("report-only");
  });

  test("a summary the agent forgot is recomputed rather than shown as zero", () => {
    const [r] = parseRounds(
      round('{"findings":[{"checkId":"A1","file":"a.yml","tier":"merge-worthy","fixKind":"deterministic","severity":"error","title":"t"},{"checkId":"B2","file":"b.yml","tier":"report-only","fixKind":"guidance","severity":"info","title":"t"}],"clusters":[]}'),
    );
    expect(r!.summary).toEqual({ total: 2, quickWin: 1, needsReview: 0, reportOnly: 1 });
  });

  test("a finding with no rule id or no file is not a finding", () => {
    const [r] = parseRounds(round('{"summary":{},"findings":[{"checkId":"A1"},{"file":"a.yml"},{"checkId":"B2","file":"b.yml"}],"clusters":[]}'));
    expect(r!.findings.map((f) => f.checkId)).toEqual(["B2"]);
  });

  test("nonsense enums fall back instead of crashing the page", () => {
    const [r] = parseRounds(round('{"summary":{},"findings":[{"checkId":"A1","file":"a.yml","severity":"critical","tier":"urgent","fixKind":"magic","category":"vibes"}],"clusters":[]}'));
    expect(r!.findings[0]).toMatchObject({ severity: "warning", tier: "report-only", fixKind: "guidance", category: "best-practice", title: "A1" });
  });

  test("a javascript: authority url is dropped", () => {
    const [r] = parseRounds(round('{"summary":{},"findings":[{"checkId":"A1","file":"a.yml","authority":{"name":"x","url":"javascript:alert(1)"}}],"clusters":[]}'));
    expect(r!.findings[0]!.authority).toEqual({ name: "x" });
  });
});

describe("round-diff", () => {
  test("attaches to its cluster by key", () => {
    const [r] = parseRounds(REPORTED);
    const ci = r!.clusters.find((c) => c.key === "github-workflows-ci-yml");
    expect(ci!.diff).toContain("+    permissions:");
    expect(r!.clusters.find((c) => c.key === "dockerfile")!.diff).toBeUndefined();
  });

  test("a diff for a cluster that is not in the round is dropped, not shown loose", () => {
    const [r] = parseRounds(`${round('{"summary":{},"clusters":[{"key":"a","file":"a.yml","status":"opened"}]}')}\n\n\`\`\`round-diff nosuchcluster\ndiff --git a/x b/x\n\`\`\``);
    expect(r!.clusters).toHaveLength(1);
    expect(r!.clusters[0]!.diff).toBeUndefined();
  });

  test("an empty diff fence is ignored", () => {
    const [r] = parseRounds(`${round('{"summary":{},"clusters":[{"key":"a","file":"a.yml","status":"opened"}]}')}\n\n\`\`\`round-diff a\n\n\`\`\``);
    expect(r!.clusters[0]!.diff).toBeUndefined();
  });
});

describe("arrangeRound", () => {
  const view = arrangeRound(parseRounds(REPORTED)[0]!);

  test("joins each file's findings to the cluster it became", () => {
    expect(view.files.map((f) => f.file)).toEqual([".github/workflows/ci.yml", "Dockerfile"]);
    expect(view.files[0]!.cluster!.pr).toBe(41);
    expect(view.files[0]!.findings.map((f) => f.checkId)).toEqual(["GHA033"]);
    expect(view.files[0]!.diff).toContain("permissions");
  });

  test("orders by what happened — opened before held back", () => {
    expect(view.files.map((f) => f.cluster!.status)).toEqual(["opened", "deferred"]);
  });

  test("the report-only tier is kept apart from the work", () => {
    expect(view.reportOnly.map((f) => f.checkId)).toEqual(["WHM021"]);
    expect(view.files.some((f) => f.file.includes("values.yaml"))).toBe(false);
  });

  test("a cluster with no findings behind it still gets shown", () => {
    const orphaned = arrangeRound(parseRounds(round('{"summary":{},"findings":[],"clusters":[{"key":"dockerfile","file":"Dockerfile","status":"failed","note":"could not verify"}]}'))[0]!);
    expect(orphaned.files).toEqual([]);
    expect(orphaned.orphans.map((c) => c.key)).toEqual(["dockerfile"]);
  });
});

// The round used to be summarized by the sentence it wrote about itself. These
// are the same summary, taken from the record instead.
describe("clusterCounts", () => {
  test("counts every status, including the ones nothing happened for", () => {
    const [r] = parseRounds(FULL);
    expect(clusterCounts(r!)).toEqual({ opened: 1, "already-open": 1, declined: 1, deferred: 0, failed: 0, clean: 0 });
  });

  test("a round with no clusters counts zeroes rather than going missing", () => {
    const [r] = parseRounds(round('{"summary":{"total":4},"clusters":[],"openPrs":0}'));
    expect(clusterCounts(r!).opened).toBe(0);
    expect(clusterCounts(r!).failed).toBe(0);
  });
});
