/**
 * Run one package script in every workspace member, and stop at the first
 * failure.
 *
 * Each member gets its own `bun` process, which is the point rather than an
 * accident. A single `bun test` from the root runs all 1,300 tests in one
 * process, and fountain-workbench's suite installs happy-dom's globals into
 * it — so apps that assert on the *absence* of a browser API (workbench's own
 * "a browser with no notifications is offered none") start seeing one and
 * fail. Separate processes is how these suites ran when they were separate
 * repositories, and it is what keeps them honest here.
 *
 * `bun run --filter '*' <script>` would also fan out, but it interleaves the
 * output of everything it runs, so a failure is hard to attribute. In series
 * the whole sweep is about a minute.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Every workspace member — apps/* and packages/* — in a stable order. */
function members(): { name: string; dir: string }[] {
  return ["apps", "packages"].flatMap((group) =>
    readdirSync(join(ROOT, group), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(ROOT, group, e.name, "package.json")))
      .map((e) => ({ name: `${group}/${e.name}`, dir: join(ROOT, group, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

const script = process.argv[2];
if (!script) {
  console.error("usage: bun run scripts/each.ts <script>");
  process.exit(2);
}

let ran = 0;
for (const m of members()) {
  const pkg = await Bun.file(join(m.dir, "package.json")).json();
  if (!pkg.scripts?.[script]) continue;
  console.log(`\n=== ${m.name}: ${script} ===`);
  const proc = Bun.spawnSync(["bun", "run", script], { cwd: m.dir, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`\n${m.name}: ${script} failed (exit ${proc.exitCode})`);
    process.exit(proc.exitCode ?? 1);
  }
  ran++;
}
console.log(`\n${ran} packages: ${script} ok`);
