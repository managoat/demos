/**
 * Run one package script in every app, and stop at the first failure.
 *
 * `bun run --filter '*' <script>` would do this, but it hides which app
 * failed behind interleaved output when several run at once. Fourteen apps
 * finish fast enough in series that reading the log is worth more than the
 * wall-clock.
 */
import { apps } from "./apps";

const script = process.argv[2];
if (!script) {
  console.error("usage: bun run scripts/each.ts <script>");
  process.exit(2);
}

for (const app of apps()) {
  console.log(`\n=== ${app.name}: ${script} ===`);
  const proc = Bun.spawnSync(["bun", "run", script], { cwd: app.dir, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`\n${app.name}: ${script} failed (exit ${proc.exitCode})`);
    process.exit(proc.exitCode ?? 1);
  }
}
console.log(`\nall apps: ${script} ok`);
