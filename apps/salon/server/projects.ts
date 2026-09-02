/**
 * Projects: a repository a chat's computer starts with a checkout of
 * (shared/projects.ts). Behind one is an Environment on the owner's
 * Fountain — the clone at its mount path, `jq` for the hook, the GitHub
 * token as a write-only secret, and a setup script that installs the hook
 * (server/sandbox.ts) and then runs whatever the owner asked. Salon keeps
 * the project row, who is in it, and never the token.
 *
 *   GET    /api/projects                        mine: owned and in
 *   POST   /api/projects                        { repoUrl, base?, name?, token?, setup? } — makes the environment
 *   GET    /api/projects/:id
 *   DELETE /api/projects/:id                    owner: removes the environment; the chats stay, unattached
 *   POST   /api/projects/:id/members            owner: { email } — into the project and every chat in it
 *   DELETE /api/projects/:id/members/:email     owner, or yourself
 *
 * A chat started in a project runs on the project owner's key whoever
 * starts it (server/chats.ts): the owner pays, as a host does, and the
 * project's people are the chat's people.
 */
import { shortName } from "../shared/author";
import { baseBranch, mountPathFor, parseRepoUrl, projectName, type ProjectDto } from "../shared/projects";
import { authenticate, userClient, type AppContext } from "./context";
import { now, type ProjectRow, type UserRow } from "./db";
import { FountainClient, FountainHttpError } from "./fountain";
import { repoToken, reposFor } from "./github-access";
import { HttpError, isEmail, json, normalizeEmail, readJson, str } from "./http";
import { githubCredentialSetupScript, hookSetupScript } from "./sandbox";

export function toDto(ctx: AppContext, p: ProjectRow, role: ProjectDto["role"]): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    ownerEmail: p.owner_email,
    role,
    members: ctx.db.projectMembers(p.id).map((m) => ({ email: m.email, addedAt: m.added_at })),
    repoUrl: p.repo_url,
    base: p.base,
    hasToken: p.has_token === 1,
    githubManaged: !!p.github_repo,
    createdAt: p.created_at,
  };
}

/** The project and the caller's role in it; 404 when they are not in it. */
export function projectAccess(ctx: AppContext, user: UserRow, id: string): { project: ProjectRow; role: ProjectDto["role"] } {
  const role = ctx.db.projectRoleIn(id, user.email);
  const project = role ? ctx.db.getProject(id) : null;
  if (!role || !project) throw new HttpError(404, "not_found", "No such project.");
  return { project, role };
}

/**
 * The Environment a project is: what Fountain builds the computer from.
 * The setup script is Salon's hook first, then the owner's git identity,
 * `gh` if the image lacks it (best effort), then the project's own command
 * in the checkout. A token names `GITHUB_TOKEN` as the clone's `secret_key`;
 * the secret itself is written separately, and never stored here.
 */
export function environmentBody(p: Pick<ProjectRow, "name" | "repo_url" | "base" | "mount_path" | "setup" | "owner_email" | "github_repo">, hasToken: boolean, publicUrl: string | null): Record<string, unknown> {
  const repo: Record<string, unknown> = { url: p.repo_url, mount_path: p.mount_path, ref: p.base };
  if (hasToken) repo.secret_key = "GITHUB_TOKEN";
  const lines = [
    publicUrl ? hookSetupScript({ publicUrl, repoPath: p.mount_path, base: p.base }) : "# Salon: no public address for this server, so no changes hook.\n",
    `git config --global user.name ${q(shortName(p.owner_email))} && git config --global user.email ${q(p.owner_email)}`,
    "command -v gh >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh >/dev/null 2>&1 || true",
  ];
  if (p.github_repo && publicUrl) lines.push(githubCredentialSetupScript(publicUrl, p.mount_path));
  if (p.setup.trim()) lines.push(`cd ${q(p.mount_path)} && (\n${p.setup.trim()}\n)`);
  return {
    name: `Salon · ${p.name}`.slice(0, 200),
    repositories: [repo],
    packages: { apt: ["jq"] },
    setup_script: lines.join("\n") + "\n",
    metadata: { salon: { project: true } },
  };
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── the routes ───────────────────────────────────────────────────────────

export async function list(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  return json({ data: ctx.db.projectsFor(user.email).map((p) => toDto(ctx, p, p.owner_email === user.email ? "owner" : "member")) });
}

export async function show(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, id);
  return json({ data: toDto(ctx, project, role) });
}

export async function create(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const body = await readJson(req);
  const githubRepo = str(body.githubRepo, 300).trim();
  let selected = null as Awaited<ReturnType<typeof reposFor>>[number] | null;
  if (githubRepo) {
    selected = (await reposFor(ctx, user)).find((r) => r.slug.toLowerCase() === githubRepo.toLowerCase()) ?? null;
    if (!selected) throw new HttpError(404, "github_repo_unavailable", "That repository is not available through your Salon GitHub App installation.");
    if (selected.archived) throw new HttpError(422, "github_repo_archived", "That repository is archived, so a session cannot push changes to it.");
  }
  const repo = parseRepoUrl(selected ? `https://github.com/${selected.slug}` : str(body.repoUrl, 500));
  if (!repo) throw new HttpError(422, "bad_repo", "That is not a repository address. Something like https://github.com/owner/repo.");
  const base = baseBranch(body.base ?? selected?.defaultBranch);
  if (!base) throw new HttpError(422, "bad_branch", "That is not a branch name.");
  const token = selected ? await repoToken(ctx, selected.slug) : str(body.token, 400).trim();
  const setup = str(body.setup, 4000);
  const row: ProjectRow = {
    id: crypto.randomUUID(),
    owner_email: user.email,
    name: projectName(body.name, repo),
    repo_url: repo.url,
    base,
    mount_path: mountPathFor(repo),
    environment_id: "",
    has_token: token ? 1 : 0,
    github_repo: selected?.slug ?? null,
    setup,
    created_at: now(),
  };
  const client = await userClient(ctx, user);
  try {
    const env = await client.createEnvironment(environmentBody(row, !!token, ctx.config.publicUrl));
    row.environment_id = env.id;
    if (token) {
      // Two names for one token: the clone reads GITHUB_TOKEN, `gh` reads GH_TOKEN.
      await client.setEnvironmentSecret(env.id, "GITHUB_TOKEN", token);
      await client.setEnvironmentSecret(env.id, "GH_TOKEN", token);
    }
  } catch (err) {
    if (row.environment_id) await client.deleteEnvironment(row.environment_id).catch(() => undefined);
    if (err instanceof FountainHttpError) throw err.toHttp("Fountain would not set the project up.");
    throw err;
  }
  ctx.db.insertProject(row);
  return json({ data: toDto(ctx, row, "owner") }, 201);
}

export async function remove(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, id);
  if (role !== "owner") throw new HttpError(403, "owner_only", "Only the project's owner can remove it.");
  try {
    await (await userClient(ctx, user)).deleteEnvironment(project.environment_id);
  } catch (err) {
    if (err instanceof FountainHttpError) throw err.toHttp("Fountain would not remove the project's computer setup. Is a chat in it mid-turn?");
    throw err;
  }
  ctx.db.detachChatsFromProject(project.id);
  ctx.db.deleteProject(project.id);
  return json({ ok: true });
}

export async function addMember(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, id);
  if (role !== "owner") throw new HttpError(403, "owner_only", "Only the project's owner can add people.");
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) throw new HttpError(422, "bad_email", "That is not an email address.");
  if (email === project.owner_email) throw new HttpError(422, "is_owner", "You own this project already.");
  ctx.db.addProjectMember(project.id, email, user.email);
  for (const chat of ctx.db.chatsInProject(project.id)) if (chat.owner_email !== email) ctx.db.addMember(chat.id, email, `project:${project.id}`);
  return json({ data: toDto(ctx, project, role) });
}

export async function removeMember(ctx: AppContext, req: Request, id: string, rawEmail: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, id);
  const email = normalizeEmail(decodeURIComponent(rawEmail));
  if (role !== "owner" && email !== user.email) throw new HttpError(403, "owner_only", "Only the project's owner can remove someone else.");
  ctx.db.removeProjectMember(project.id, email);
  // Out of the project's chats too — the ones the project put them in. A chat they were invited to by hand keeps them.
  for (const chat of ctx.db.chatsInProject(project.id)) {
    const m = ctx.db.members(chat.id).find((x) => x.email === email);
    if (m && m.added_by === `project:${project.id}`) ctx.db.removeMember(chat.id, email);
  }
  if (email === user.email) return json({ ok: true, left: true });
  return json({ data: toDto(ctx, project, role) });
}

/**
 * The environment as Salon would write it today, put back if it differs:
 * the hook lives in the setup script, so a project made before a change to
 * the hook would keep the old one forever. Called when a chat starts in the
 * project; one read, and a write only when something moved. A write is
 * best-effort — the chat starts either way — and a mid-turn refusal
 * (`409 sandbox_mid_turn`) is simply tried again next time.
 */
export async function refreshEnvironment(ctx: AppContext, client: FountainClient, project: ProjectRow): Promise<boolean> {
  const want = environmentBody(project, project.has_token === 1, ctx.config.publicUrl);
  try {
    // Installation tokens last one hour. Replace the write-only Fountain
    // secrets immediately before every session so cloning and `gh` begin fresh.
    if (project.github_repo) {
      const token = await repoToken(ctx, project.github_repo);
      await client.setEnvironmentSecret(project.environment_id, "GITHUB_TOKEN", token);
      await client.setEnvironmentSecret(project.environment_id, "GH_TOKEN", token);
    }
    const have = await client.environment(project.environment_id);
    if (!have) return false;
    const same = have.setup_script === want.setup_script && JSON.stringify(have.repositories ?? []) === JSON.stringify(want.repositories);
    if (same) return false;
    await client.updateEnvironment(project.environment_id, { repositories: want.repositories, packages: want.packages, setup_script: want.setup_script });
    return true;
  } catch (err) {
    console.warn(`salon: could not refresh the environment of project ${project.id}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** A client on the project owner's key: what its chats run on. */
export async function projectOwnerClient(ctx: AppContext, project: ProjectRow): Promise<{ owner: UserRow; client: FountainClient }> {
  const owner = ctx.db.getUser(project.owner_email);
  if (!owner) throw new HttpError(409, "owner_gone", "The project's owner no longer has an account here.");
  return { owner, client: new FountainClient(ctx.config.fountainUrl, await ctx.cipher.decrypt(owner.key_enc)) };
}
