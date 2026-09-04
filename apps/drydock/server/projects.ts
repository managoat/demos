/**
 * Making a project, which is making three Fountain records and then never
 * touching their ids again.
 *
 * A sandbox's identity is `(user, agent, environment, vault)`. Every machine
 * this project ever builds is built from that tuple, so the tuple is the
 * project — and the one rule this file exists to keep is that its three ids
 * are written once, at creation, and only ever *mutated in place* afterwards.
 * Replacing one is not a settings change, it is a different project wearing
 * the same name.
 *
 * The three do different jobs, and which one a setting lives in is the only
 * interesting decision here:
 *
 *   **The environment builds the disk.** Repository, packages, setup script.
 *     Change one and the next machine has it — which in drydock means the
 *     next *thread*, immediately, because every thread is a fresh machine.
 *     Paddock had to invent a whole apply-and-verify protocol for this; here
 *     it falls out of the model for nothing.
 *   **The agent is who works.** Model, system prompt, skills, MCP servers.
 *     Injected when a session starts, so it reaches the next thread and not an
 *     open one.
 *   **The vault holds what must not be on the disk.** Exactly one thing today:
 *     the GitHub installation token — see `refreshCloneToken`.
 */
import type { GitHub } from "./github";
import { asHttpError as githubError } from "./github";
import type { Fountain } from "./fountain";
import { asHttpError as fountainError } from "./fountain";
import type { Db, ProjectRow, UserRow } from "./db";
import { HttpError } from "./http";
import { fountainName, mountPathFor } from "../shared/ids";
import { systemPrompt } from "../shared/spec";

/** The model a project starts on when nobody has said otherwise. */
export const DEFAULT_MODEL = "anthropic/claude-opus-5";
export const DEFAULT_RUNTIME = "claude";

/**
 * The two names one token is written under.
 *
 * `GITHUB_TOKEN` is what the repository's `secret_key` names, so it is what
 * Fountain's clone uses as HTTPS `x-access-token` auth. `GH_TOKEN` is what the
 * `gh` CLI reads, and an agent that can browse a repository but cannot run
 * `gh pr view` is an agent that will try to and then explain that it cannot.
 * Both names are in Fountain's broker catalog, so where a broker is configured
 * neither value ever reaches the machine — the box holds `__github_token__`
 * and the broker substitutes the real thing in flight.
 */
const CLONE_KEYS = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

export interface NewProject {
  name: string;
  /** `owner/name`, or null for a project with no repository. */
  repo: string | null;
  repoPrivate: boolean;
  defaultBranch: string | null;
  installationId: number | null;
  model: string;
}

/**
 * Build the three records, then the row.
 *
 * In that order, and the order is not arbitrary: the row is the only thing
 * that can be rolled back cheaply, so it is written last. If Fountain accepts
 * the vault and refuses the agent, what is left behind is two orphan records
 * on the Fountain account and no project here — untidy, and recoverable by
 * making the project again. The other order leaves a project row pointing at
 * an agent that does not exist, which looks like a working project until
 * somebody opens a thread on it.
 */
export async function createProject(
  deps: { db: Db; fountain: Fountain; github: GitHub | null },
  user: UserRow,
  input: NewProject,
): Promise<ProjectRow> {
  const id = crypto.randomUUID();
  const repoPath = input.repo ? mountPathFor(input.repo) : null;

  // Minted before the environment, because the environment's `secret_key`
  // names a secret that has to already exist by the time a machine is built
  // from it. Nothing builds one yet, so this is belt and braces — but the
  // alternative is a first thread that fails to clone for a reason nobody
  // could see from here.
  let cloneToken: string | null = null;
  if (input.repo && input.installationId != null) {
    if (!deps.github) throw new HttpError(503, "no_github", "This drydock has no GitHub App configured.");
    try {
      cloneToken = await deps.github.mintCloneToken(input.installationId, input.repo);
    } catch (err) {
      throw githubError(err, "get access to that repository");
    }
  }

  try {
    const vault = await deps.fountain.createVault({ name: fountainName("vault", input.name, id) });
    if (cloneToken) {
      for (const key of CLONE_KEYS) await deps.fountain.putSecret("vaults", vault.id, key, cloneToken);
    }

    const environment = await deps.fountain.createEnvironment({
      name: fountainName("env", input.name, id),
      repositories:
        input.repo && repoPath
          ? [
              {
                url: `https://github.com/${input.repo}`,
                mount_path: repoPath,
                // Named whether or not the repository is private. A public
                // clone with a valid token is identical to one without, and a
                // repository that goes private later then keeps working
                // instead of failing on the next thread with a 404 that reads
                // like the repository was deleted.
                ...(cloneToken ? { secret_key: "GITHUB_TOKEN" } : {}),
                ...(input.defaultBranch ? { ref: input.defaultBranch } : {}),
              },
            ]
          : [],
      packages: { apt: [], npm: [] },
      setup_script: "",
    });

    const agent = await deps.fountain.createAgent({
      name: fountainName("agent", input.name, id),
      model: input.model,
      runtime: DEFAULT_RUNTIME,
      description: `Drydock project "${input.name}"${input.repo ? ` on ${input.repo}` : ""}.`,
      system: systemPrompt({ project: input.name, repo: input.repo, repoPath, instructions: "" }),
      environment_id: environment.id,
      // The whole model in one field. Every conversation on this agent gets a
      // machine of its own, built from the environment above and reclaimed
      // when the conversation ends.
      sandbox_mode: "ephemeral",
      // The project's own vault and nothing else. A project cannot reach
      // another project's secrets even though both live on this server's one
      // Fountain account, which is the only isolation available at this layer.
      allowed_vault_ids: [vault.id],
      metadata: { drydock: { project: id, owner: user.login } },
    });

    return deps.db.createProject({
      id,
      userId: user.id,
      name: input.name,
      repoFullName: input.repo,
      repoPrivate: input.repoPrivate ? 1 : 0,
      defaultBranch: input.defaultBranch,
      installationId: input.installationId,
      agentId: agent.id,
      environmentId: environment.id,
      vaultId: vault.id,
      runtime: DEFAULT_RUNTIME,
      model: input.model,
      instructions: "",
    });
  } catch (err) {
    throw fountainError(err, "build this project");
  }
}

/**
 * Put a fresh clone token in the vault.
 *
 * An installation token lives for an hour and a thread's machine is built when
 * the thread opens, so the token that matters is the one in the vault *at that
 * moment* — not the one that was there when the project was made last Tuesday.
 * Every path that is about to build a machine calls this first. The GitHub
 * client caches until a minute before expiry, so in the common case this is
 * one SQLite read and two writes to Fountain.
 *
 * A failure here is not fatal and does not stop a thread opening: a project
 * with a public repository does not need a token at all, and one whose
 * installation was removed should fail at the clone with GitHub's own words
 * rather than here with ours.
 */
export async function refreshCloneToken(
  deps: { fountain: Fountain; github: GitHub | null },
  project: ProjectRow,
): Promise<void> {
  if (!project.vaultId || !project.repoFullName || project.installationId == null || !deps.github) return;
  try {
    const token = await deps.github.mintCloneToken(project.installationId, project.repoFullName);
    for (const key of CLONE_KEYS) await deps.fountain.putSecret("vaults", project.vaultId, key, token);
  } catch (err) {
    console.error(`drydock: could not refresh the clone token for project ${project.id}:`, err);
  }
}

/**
 * Everything a settings edit can change, and where each piece lands.
 *
 * Returns the project's new revision when something Fountain injects at
 * session start moved, so the caller can stamp it on threads opened from now
 * on. A revision that did not move is not bumped — an edit that saved the same
 * text should not mark every open thread stale.
 */
export async function updateSettings(
  deps: { db: Db; fountain: Fountain },
  project: ProjectRow,
  patch: { name?: string; setupScript?: string; packages?: Record<string, string[]>; model?: string; instructions?: string },
): Promise<ProjectRow> {
  let bump = false;

  try {
    // On the disk. Lands on the next thread, because the next thread is a new
    // machine — no apply step, no receipt, nothing to verify.
    if (patch.setupScript !== undefined || patch.packages !== undefined) {
      await deps.fountain.updateEnvironment(project.environmentId, {
        ...(patch.setupScript !== undefined ? { setup_script: patch.setupScript } : {}),
        ...(patch.packages !== undefined ? { packages: patch.packages } : {}),
      });
    }

    // On the agent. Injected when a session starts, so an open thread keeps
    // what it opened with and is badged for it.
    const name = patch.name ?? project.name;
    const instructions = patch.instructions ?? project.instructions;
    const model = patch.model ?? project.model;
    if (patch.model !== undefined || patch.instructions !== undefined || patch.name !== undefined) {
      await deps.fountain.updateAgent(project.agentId, {
        model,
        system: systemPrompt({
          project: name,
          repo: project.repoFullName,
          repoPath: project.repoFullName ? mountPathFor(project.repoFullName) : null,
          instructions,
        }),
      });
      bump = patch.model !== project.model || instructions !== project.instructions;
    }
  } catch (err) {
    throw fountainError(err, "save these settings");
  }

  if (patch.name !== undefined && patch.name !== project.name) deps.db.renameProject(project.id, patch.name);
  if (patch.instructions !== undefined) deps.db.setInstructions(project.id, patch.instructions);
  if (patch.model !== undefined) deps.db.setModel(project.id, patch.model);
  if (bump) deps.db.bumpRev(project.id);

  return deps.db.project(project.id)!;
}

/**
 * Take a project away, and the three records with it.
 *
 * Ordered agent → environment → vault because Fountain refuses to delete an
 * environment an agent still points at. Each failure is swallowed and logged
 * rather than aborting the sequence: the row is archived either way, and a
 * project the person has already stopped seeing must not come back because a
 * cleanup call timed out. What is left behind in that case is an orphan record
 * on the Fountain account, which is untidy and not dangerous.
 */
export async function retireProject(deps: { db: Db; fountain: Fountain }, project: ProjectRow): Promise<void> {
  const drop = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`drydock: could not delete the ${what} for project ${project.id}:`, err);
    }
  };
  await drop("agent", () => deps.fountain.deleteAgent(project.agentId));
  await drop("environment", () => deps.fountain.deleteEnvironment(project.environmentId));
  if (project.vaultId) await drop("vault", () => deps.fountain.deleteVault(project.vaultId!));
  deps.db.archiveProject(project.id);
}
