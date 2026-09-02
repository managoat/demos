/**
 * The apps in this repo, read off the filesystem.
 *
 * The one list nothing can disagree with: a directory under `apps/` with a
 * `k8s/` beside it is an app the cluster runs. CI's build matrix, the
 * typecheck fan-out and fountain-demos' drift check all derive from this
 * rather than keeping their own copy — which is the thing that went wrong
 * when these were fourteen repositories.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

export interface App {
  name: string;
  dir: string;
  /** Deployed by the cluster — has k8s manifests of its own. */
  deployed: boolean;
  /** Has a Dockerfile, so CI builds and pushes an image for it. */
  built: boolean;
}

export function apps(): App[] {
  return readdirSync(join(ROOT, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      dir: join(ROOT, "apps", e.name),
      deployed: existsSync(join(ROOT, "apps", e.name, "k8s", "kustomization.yaml")),
      built: existsSync(join(ROOT, "apps", e.name, "Dockerfile")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.main) {
  const list = apps();
  if (process.argv.includes("--json")) console.log(JSON.stringify(list.map((a) => a.name)));
  else for (const a of list) console.log(`${a.name}${a.deployed ? "" : "  (not deployed)"}`);
}
