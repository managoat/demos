/**
 * Which apps a push actually touched — CI's build matrix.
 *
 * Fourteen repositories each rebuilt only themselves, because there was
 * nothing else in the repository to rebuild. One repository has to work that
 * out, and the answer is not "the directories that changed": a change under
 * `packages/` or to the root toolchain reaches every app, and shipping only
 * the app whose file happened to move would leave the other thirteen running
 * an image built against the old library.
 *
 * So: anything shared → all apps. Otherwise → the apps whose own directory
 * changed, ignoring the two kinds of file that cannot affect an image
 * (`k8s/`, which is what the pin step itself writes, and prose).
 *
 * Usage: bun run scripts/changed.ts <base-sha> <head-sha>
 */
import { apps } from "./apps";

/** A change to any of these rebuilds everything. */
const SHARED = [/^packages\//, /^scripts\//, /^package\.json$/, /^bun\.lock$/, /^tsconfig(\.\w+)?\.json$/, /^\.github\/workflows\//];

/** Files inside an app that cannot change its image. */
const INERT = [/^apps\/[^/]+\/k8s\//, /^apps\/[^/]+\/README\.md$/, /^apps\/[^/]+\/LICENSE$/];

export function changedApps(files: string[], known: string[]): string[] {
  const relevant = files.filter((f) => !INERT.some((re) => re.test(f)));
  if (relevant.some((f) => SHARED.some((re) => re.test(f)))) return [...known];

  const touched = new Set<string>();
  for (const f of relevant) {
    const m = /^apps\/([^/]+)\//.exec(f);
    if (m && known.includes(m[1]!)) touched.add(m[1]!);
  }
  return known.filter((a) => touched.has(a));
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  const known = apps().map((a) => a.name);

  // No base (a first push, or a force-push past the old tip): build everything
  // rather than guess, since a missed app ships nothing and is silent.
  let files: string[] = [];
  if (base && head) {
    const proc = Bun.spawnSync(["git", "diff", "--name-only", `${base}..${head}`]);
    if (proc.exitCode !== 0) {
      console.error(new TextDecoder().decode(proc.stderr).trim());
      console.log(JSON.stringify(known));
      process.exit(0);
    }
    files = new TextDecoder().decode(proc.stdout).split("\n").filter(Boolean);
  } else {
    console.log(JSON.stringify(known));
    process.exit(0);
  }

  console.log(JSON.stringify(changedApps(files, known)));
}
