/**
 * Every route drydock has.
 *
 * The shape of this list is the permission model. There is no proxy here and
 * no forwarding: the browser holds no Fountain key, so it cannot reach a
 * Fountain path unless a handler below decides to go there on its behalf.
 * Anything not written down is not reachable, which is a much easier property
 * to check than an allowlist.
 *
 * Every project route resolves through `projectOf`, which selects on the
 * caller's `user_id` as well as the project id — so somebody else's project is
 * *not found* rather than refused, and its existence is not the caller's to
 * learn. `threadOf` does the same one level down. Those two functions are the
 * whole of the tenancy story, and they are the only two places it is enforced.
 */
import type { Server } from "bun";
import type { TerminalData } from "./terminal";
import * as auth from "./auth";
import { authenticate, projectOf, requireFountain, requireGitHub, requireSprites, threadOf, userToken } from "./context";
import type { AppContext } from "./context";
import { HttpError, errorResponse, json, readJson, str } from "./http";
import { asHttpError as githubError } from "./github";
import { asHttpError as fountainError } from "./fountain";
import * as projects from "./projects";
import * as threads from "./threads";
import { resolveCwd } from "./sprites";
import { parseDiff } from "../shared/diff";
import { mountPathFor } from "../shared/ids";
import type { Project, ProjectSettings, ThreadOrigin } from "../shared/api";
import type { Origin } from "../shared/spec";
import type { ProjectRow, UserRow } from "./db";

import { hub } from "./hub";

type Handler = (req: Request, params: Record<string, string>, server: Server<TerminalData> | null) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

export function buildRouter(ctx: AppContext): (req: Request, server: Server<TerminalData> | null) => Promise<Response> {
  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler) => {
    routes.push({ method, pattern: path.split("/").filter(Boolean), handler });
  };

  // ── the app itself ───────────────────────────────────────────────────

  on("GET", "/healthz", () => new Response("ok\n", { headers: { "content-type": "text/plain" } }));

  on("GET", "/api/session", (req) => auth.session(ctx, req));
  on("GET", "/api/auth/callback", (req) => auth.callback(ctx, req));
  on("GET", "/api/auth/install", (req) => auth.install(ctx, req));
  on("DELETE", "/api/auth/session", (req) => auth.signOut(ctx, req));
  on("POST", "/api/github/webhook", (req) => auth.webhook(ctx, req));

  // ── GitHub, read as the person who asked ─────────────────────────────

  on("GET", "/api/github/installations", (req) => auth.installations(ctx, req));

  on("GET", "/api/github/repos", async (req) => {
    const gh = requireGitHub(ctx);
    const user = await authenticate(ctx, req);
    const token = await userToken(ctx, user);
    const asked = new URL(req.url).searchParams.get("installation_id");
    try {
      const installations = await gh.installationsFor(token);
      // Everything the person can see, across every installation, unless they
      // named one. A picker that silently showed only the first installation's
      // repositories is a bug nobody reports — they just conclude the app
      // cannot see the repository they wanted.
      const wanted = asked ? installations.filter((i) => String(i.id) === asked) : installations;
      const lists = await Promise.all(wanted.map((i) => gh.repositories(token, i.id)));
      return json({ data: lists.flat().sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "")) });
    } catch (err) {
      throw githubError(err, "list your repositories");
    }
  });

  // The three tabs of the Create from… picker. Read as the *installation*
  // rather than as the person, because that is the token with access to a
  // private repository's pull requests.
  on("GET", "/api/github/repo/:owner/:name/branches", (req, p) => repoRead(ctx, req, p, "branches"));
  on("GET", "/api/github/repo/:owner/:name/pulls", (req, p) => repoRead(ctx, req, p, "pulls"));
  on("GET", "/api/github/repo/:owner/:name/issues", (req, p) => repoRead(ctx, req, p, "issues"));

  // ── projects ─────────────────────────────────────────────────────────

  on("GET", "/api/projects", async (req) => {
    const user = await authenticate(ctx, req);
    return json({ data: ctx.db.projectsOf(user.id).map((p) => projectView(ctx, p, user)) });
  });

  on("POST", "/api/projects", async (req) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const body = await readJson<{ name?: string; repo?: string; installationId?: number; model?: string }>(req);

    const repo = str(body.repo, 200).trim() || null;
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, "bad_repo", "A repository is `owner/name`.");

    // The repository is read before anything is created, so a typo or a
    // repository the installation cannot see fails here rather than after
    // three Fountain records have been made for it.
    let repoPrivate = false;
    let defaultBranch: string | null = null;
    let installationId: number | null = null;
    if (repo) {
      const gh = requireGitHub(ctx);
      installationId = Number(body.installationId);
      if (!Number.isFinite(installationId)) {
        const found = await findInstallationFor(ctx, user, repo);
        installationId = found;
      }
      try {
        const info = await gh.repository(installationId, repo);
        repoPrivate = info.private;
        defaultBranch = info.defaultBranch;
      } catch (err) {
        throw githubError(err, "read that repository");
      }
    }

    const name = str(body.name, 80).trim() || repo?.split("/").pop() || "New project";
    const project = await projects.createProject({ db: ctx.db, fountain, github: ctx.github }, user, {
      name,
      repo,
      repoPrivate,
      defaultBranch,
      installationId,
      model: str(body.model, 80).trim() || projects.DEFAULT_MODEL,
    });
    return json({ data: projectView(ctx, project, user) }, 201);
  });

  on("GET", "/api/projects/:id", async (req, p) => {
    const user = await authenticate(ctx, req);
    return json({ data: projectView(ctx, projectOf(ctx, user, p.id!), user) });
  });

  on("PATCH", "/api/projects/:id", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const project = projectOf(ctx, user, p.id!);
    const body = await readJson<Partial<ProjectSettings>>(req);
    const updated = await projects.updateSettings({ db: ctx.db, fountain }, project, {
      ...(body.name !== undefined ? { name: str(body.name, 80).trim() || project.name } : {}),
      ...(body.setupScript !== undefined ? { setupScript: str(body.setupScript, 20_000) } : {}),
      ...(body.packages !== undefined ? { packages: cleanPackages(body.packages) } : {}),
      ...(body.model !== undefined ? { model: str(body.model, 80).trim() || project.model } : {}),
      ...(body.instructions !== undefined ? { instructions: str(body.instructions, 20_000) } : {}),
    });
    hub.publish(updated.id, { event: "settings", data: { rev: updated.rev } });
    return json({ data: projectView(ctx, updated, user) });
  });

  on("DELETE", "/api/projects/:id", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const project = projectOf(ctx, user, p.id!);
    // Every thread first: an ephemeral machine outliving the project that
    // built it is a machine nothing can reach and nothing will reclaim.
    for (const row of ctx.db.threadsOf(project.id)) await threads.closeThread({ db: ctx.db, fountain }, row);
    await projects.retireProject({ db: ctx.db, fountain }, project);
    return json({ data: { ok: true } });
  });

  /** The Setup panel: what the environment and the agent currently say. */
  on("GET", "/api/projects/:id/settings", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const project = projectOf(ctx, user, p.id!);
    try {
      const [environment, envSecrets, vaultSecrets] = await Promise.all([
        fountain.getEnvironment(project.environmentId),
        fountain.secretKeys("environments", project.environmentId).catch(() => []),
        project.vaultId ? fountain.secretKeys("vaults", project.vaultId).catch(() => []) : Promise.resolve([]),
      ]);
      const settings: ProjectSettings = {
        name: project.name,
        setupScript: environment.setup_script ?? "",
        packages: environment.packages ?? { apt: [], npm: [] },
        envKeys: envSecrets.map((s) => s.key),
        // The clone token is drydock's own plumbing, not a secret somebody
        // put there, and showing it in a list they can delete from invites
        // exactly one very confusing bug report.
        vaultKeys: vaultSecrets.map((s) => s.key).filter((k) => k !== "GITHUB_TOKEN" && k !== "GH_TOKEN"),
        model: project.model,
        instructions: project.instructions,
      };
      return json({ data: settings });
    } catch (err) {
      throw fountainError(err, "read this project's settings");
    }
  });

  on("POST", "/api/projects/:id/secrets", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const project = projectOf(ctx, user, p.id!);
    const body = await readJson<{ store?: string; key?: string; value?: string }>(req);
    const store = body.store === "vault" ? "vaults" : "environments";
    const key = str(body.key, 128).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new HttpError(400, "bad_key", "A secret's name is letters, digits and underscores.");
    if (key === "GITHUB_TOKEN" || key === "GH_TOKEN") {
      throw new HttpError(409, "reserved_key", "Drydock manages that name itself — it is the token your repository is cloned with.");
    }
    const target = store === "vaults" ? project.vaultId : project.environmentId;
    if (!target) throw new HttpError(503, "no_vault", "This project has no vault.");
    try {
      await fountain.putSecret(store, target, key, str(body.value, 8000));
    } catch (err) {
      throw fountainError(err, "save that secret");
    }
    ctx.db.bumpRev(project.id);
    hub.publish(project.id, { event: "settings", data: { rev: ctx.db.project(project.id)!.rev } });
    return json({ data: { ok: true } });
  });

  on("DELETE", "/api/projects/:id/secrets/:store/:key", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const project = projectOf(ctx, user, p.id!);
    const store = p.store === "vault" ? "vaults" : "environments";
    const target = store === "vaults" ? project.vaultId : project.environmentId;
    if (!target) throw new HttpError(404, "not_found", "No such store.");
    try {
      await fountain.deleteSecret(store, target, p.key!);
    } catch (err) {
      throw fountainError(err, "remove that secret");
    }
    ctx.db.bumpRev(project.id);
    return json({ data: { ok: true } });
  });

  // ── the Run tab's saved commands ─────────────────────────────────────

  on("GET", "/api/projects/:id/commands", async (req, p) => {
    const user = await authenticate(ctx, req);
    const project = projectOf(ctx, user, p.id!);
    return json({ data: ctx.db.runCommands(project.id) });
  });

  on("POST", "/api/projects/:id/commands", async (req, p) => {
    const user = await authenticate(ctx, req);
    const project = projectOf(ctx, user, p.id!);
    const body = await readJson<{ label?: string; command?: string }>(req);
    const command = str(body.command, 2000).trim();
    if (!command) throw new HttpError(400, "empty", "A command needs something to run.");
    return json({ data: ctx.db.addRunCommand(project.id, str(body.label, 60).trim() || command.slice(0, 40), command) }, 201);
  });

  on("DELETE", "/api/projects/:id/commands/:cmd", async (req, p) => {
    const user = await authenticate(ctx, req);
    const project = projectOf(ctx, user, p.id!);
    ctx.db.removeRunCommand(project.id, p.cmd!);
    return json({ data: { ok: true } });
  });

  // ── threads ──────────────────────────────────────────────────────────

  on("GET", "/api/projects/:id/threads", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const project = projectOf(ctx, user, p.id!);
    return json({ data: await threads.listThreads({ db: ctx.db, fountain }, project) });
  });

  on("POST", "/api/projects/:id/threads", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const project = projectOf(ctx, user, p.id!);
    const body = await readJson<{ title?: string; prompt?: string; origin?: Partial<ThreadOrigin> }>(req);
    const row = await threads.openThread({ db: ctx.db, fountain, github: ctx.github }, user, project, {
      title: str(body.title, 120),
      prompt: str(body.prompt, 20_000),
      origin: readOrigin(body.origin, project),
    });
    hub.publish(project.id, { event: "threads", data: { projectId: project.id } });
    return json({ data: await threads.reconcile({ db: ctx.db, fountain }, project, row) }, 201);
  });

  on("GET", "/api/threads/:id", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread, project } = threadOf(ctx, user, p.id!);
    return json({ data: await threads.reconcile({ db: ctx.db, fountain }, project, thread) });
  });

  on("GET", "/api/threads/:id/header", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread, project } = threadOf(ctx, user, p.id!);
    const setup = await fountain
      .getEnvironment(project.environmentId)
      .then((e) => e.setup_script ?? "")
      .catch(() => "");
    return json({ data: await threads.header({ fountain }, project, thread, setup) });
  });

  on("PATCH", "/api/threads/:id", async (req, p) => {
    const user = await authenticate(ctx, req);
    const { thread, project } = threadOf(ctx, user, p.id!);
    const body = await readJson<{ title?: string }>(req);
    const title = str(body.title, 120).trim();
    if (title) ctx.db.renameThread(thread.id, title);
    hub.publish(project.id, { event: "threads", data: { projectId: project.id } });
    return json({ data: { ok: true } });
  });

  on("DELETE", "/api/threads/:id", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread, project } = threadOf(ctx, user, p.id!);
    await threads.closeThread({ db: ctx.db, fountain }, thread);
    hub.publish(project.id, { event: "threads", data: { projectId: project.id } });
    return json({ data: { ok: true } });
  });

  on("POST", "/api/threads/:id/prompt", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread, project } = threadOf(ctx, user, p.id!);
    if (!thread.conversationId) throw new HttpError(409, "not_open", "This thread's machine is still being built.");
    const body = await readJson<{ prompt?: string }>(req);
    const prompt = str(body.prompt, 40_000).trim();
    if (!prompt) throw new HttpError(400, "empty", "Say something.");
    try {
      await fountain.prompt(thread.conversationId, prompt);
    } catch (err) {
      throw fountainError(err, "send that");
    }
    hub.publish(project.id, { event: "threads", data: { projectId: project.id } });
    return json({ data: { ok: true } });
  });

  on("POST", "/api/threads/:id/interrupt", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread } = threadOf(ctx, user, p.id!);
    if (!thread.conversationId) throw new HttpError(409, "not_open", "Nothing to interrupt yet.");
    try {
      await fountain.interrupt(thread.conversationId);
    } catch (err) {
      throw fountainError(err, "interrupt this turn");
    }
    return json({ data: { ok: true } });
  });

  // ── the transcript ───────────────────────────────────────────────────

  /**
   * History and the live tail, both proxied from Fountain with the blocks
   * already parsed (`?blocks=true`), so the browser never has to learn a
   * runtime's dialect.
   */
  on("GET", "/api/threads/:id/events", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread } = threadOf(ctx, user, p.id!);
    if (!thread.conversationId) return json({ data: [], meta: { has_more: false, next_cursor: null } });
    const url = new URL(req.url);
    const qs = new URLSearchParams({ blocks: "true", limit: url.searchParams.get("limit") ?? "500" });
    const after = url.searchParams.get("after");
    if (after) qs.set("after", after);
    const res = await fountain.raw("GET", `/api/conversations/${thread.conversationId}/events?${qs}`, { accept: "application/json" });
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
  });

  on("GET", "/api/threads/:id/stream", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread } = threadOf(ctx, user, p.id!);
    if (!thread.conversationId) throw new HttpError(409, "not_open", "This thread has no conversation yet.");
    const last = req.headers.get("last-event-id");
    const upstream = await fountain.raw(
      "GET",
      `/api/conversations/${thread.conversationId}/stream?${new URLSearchParams({ blocks: "true" })}`,
      { accept: "text/event-stream", signal: req.signal, headers: last ? { "last-event-id": last } : {} },
    );
    // Handed back with the body still open. Reading it to completion is the
    // one thing a server-sent stream never does.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
    });
  });

  /** Threads appearing, settling and going stale — drydock's own events. */
  on("GET", "/api/projects/:id/stream", async (req, p) => {
    const user = await authenticate(ctx, req);
    const project = projectOf(ctx, user, p.id!);
    return hub.subscribe(project.id, req.signal);
  });

  // ── the machine, read for free through Fountain ──────────────────────

  on("GET", "/api/threads/:id/files", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread } = threadOf(ctx, user, p.id!);
    const sandbox = requireSandbox(thread.sandboxId);
    const path = new URL(req.url).searchParams.get("path") || thread.workdir;
    try {
      const listing = await fountain.listing(sandbox, path);
      return json({
        data: {
          path: listing.path,
          truncated: listing.truncated,
          entries: (listing.entries ?? []).map((e) => ({ name: e.name, type: e.type, size: e.size ?? null, change: null })),
        },
      });
    } catch (err) {
      throw fountainError(err, "list that directory");
    }
  });

  on("GET", "/api/threads/:id/file", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread } = threadOf(ctx, user, p.id!);
    const sandbox = requireSandbox(thread.sandboxId);
    const path = new URL(req.url).searchParams.get("path");
    if (!path) throw new HttpError(400, "no_path", "Which file?");
    try {
      return json({ data: await fountain.file(sandbox, path) });
    } catch (err) {
      throw fountainError(err, "read that file");
    }
  });

  on("GET", "/api/threads/:id/diff", async (req, p) => {
    const user = await authenticate(ctx, req);
    const fountain = requireFountain(ctx);
    const { thread } = threadOf(ctx, user, p.id!);
    const sandbox = requireSandbox(thread.sandboxId);
    try {
      const raw = await fountain.diff(sandbox, thread.workdir);
      // Parsed here rather than in the browser so the file list and the badge
      // count come from one implementation, and so the Changes tab can show a
      // count without shipping the whole diff to render it.
      return json({ data: { path: raw.path, diff: raw.diff ?? "", truncated: !!raw.truncated, files: parseDiff(raw.diff ?? "") } });
    } catch (err) {
      throw fountainError(err, "read this thread's changes");
    }
  });

  // ── GitHub, about this thread's branch ───────────────────────────────

  on("GET", "/api/threads/:id/checks", async (req, p) => {
    const gh = requireGitHub(ctx);
    const user = await authenticate(ctx, req);
    const { thread, project } = threadOf(ctx, user, p.id!);
    if (!project.repoFullName || project.installationId == null || !thread.branch) {
      return json({ data: { ref: thread.branch ?? "", sha: null, pushed: false, runs: [], pull: null } });
    }
    try {
      return json({ data: await gh.checks(project.installationId, project.repoFullName, thread.branch) });
    } catch (err) {
      throw githubError(err, "read this branch's checks");
    }
  });

  on("POST", "/api/threads/:id/pull", async (req, p) => {
    const gh = requireGitHub(ctx);
    const user = await authenticate(ctx, req);
    const { thread, project } = threadOf(ctx, user, p.id!);
    if (!project.repoFullName || project.installationId == null || !thread.branch) {
      throw new HttpError(409, "no_repo", "This thread has no repository to open a pull request on.");
    }
    const body = await readJson<{ title?: string; body?: string; draft?: boolean }>(req);
    try {
      return json({
        data: await gh.openPull(project.installationId, project.repoFullName, {
          head: thread.branch,
          base: thread.originBase ?? project.defaultBranch ?? "main",
          title: str(body.title, 200).trim() || thread.title,
          body: str(body.body, 20_000),
          draft: !!body.draft,
        }),
      });
    } catch (err) {
      throw githubError(err, "open a pull request");
    }
  });

  // ── the machine, driven directly over Sprites ────────────────────────

  on("POST", "/api/threads/:id/exec", async (req, p) => {
    const user = await authenticate(ctx, req);
    const sprites = requireSprites(ctx);
    const fountain = requireFountain(ctx);
    const { thread } = threadOf(ctx, user, p.id!);
    const body = await readJson<{ command?: string; cwd?: string; timeoutSec?: number }>(req);
    const command = str(body.command, 8000).trim();
    if (!command) throw new HttpError(400, "empty", "Nothing to run.");
    const { spriteName, workdir } = await threads.spriteOf({ fountain, sprites }, thread);
    const cwd = resolveCwd(workdir, str(body.cwd, 1000) || undefined);
    const timeout = Math.min(600, Math.max(1, Number(body.timeoutSec) || 120));
    const result = await sprites.shell(spriteName, command, cwd, timeout);
    return json({ data: result });
  });

  /**
   * The terminal, upgraded rather than answered.
   *
   * A browser cannot put a bearer token on a WebSocket upgrade, and the
   * Sprites token must never be in a browser regardless — so the browser's
   * socket carries a drydock session cookie, this route checks it, and
   * `terminal.ts` bridges the two sockets byte for byte.
   */
  on("GET", "/api/threads/:id/terminal", async (req, p, server) => {
    if (!server) throw new HttpError(500, "no_server", "No server to upgrade on.");
    const user = await authenticate(ctx, req);
    const sprites = requireSprites(ctx);
    const fountain = requireFountain(ctx);
    const { thread } = threadOf(ctx, user, p.id!);
    const { spriteName, workdir } = await threads.spriteOf({ fountain, sprites }, thread);
    const url = new URL(req.url);
    const upgraded = server.upgrade(req, {
      data: {
        kind: "terminal" as const,
        spriteName,
        cwd: workdir,
        rows: Number(url.searchParams.get("rows")) || 24,
        cols: Number(url.searchParams.get("cols")) || 80,
      },
    });
    if (upgraded) return undefined as unknown as Response;
    throw new HttpError(400, "not_websocket", "That route is a WebSocket.");
  });

  // ── dispatch ─────────────────────────────────────────────────────────

  return async (req: Request, server: Server<TerminalData> | null): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      const segments = path.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== "*" && route.method !== req.method.toUpperCase()) continue;
        const params = match(route.pattern, segments);
        if (params) return await route.handler(req, params, server);
      }
      if (path.startsWith("/api/")) throw new HttpError(404, "not_found", `No route ${req.method} ${path}.`);
      return serveStatic(ctx, path);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

// ── the small shared pieces ────────────────────────────────────────────

function match(pattern: string[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segments[i]!);
    else if (part !== segments[i]) return null;
  }
  return params;
}

function requireSandbox(sandboxId: string | null): string {
  if (!sandboxId) throw new HttpError(409, "no_machine", "This thread's machine is still being built.");
  return sandboxId;
}

async function repoRead(
  ctx: AppContext,
  req: Request,
  p: Record<string, string>,
  what: "branches" | "pulls" | "issues",
): Promise<Response> {
  const gh = requireGitHub(ctx);
  const user = await authenticate(ctx, req);
  const full = `${p.owner}/${p.name}`;
  const installationId = Number(new URL(req.url).searchParams.get("installation_id")) || (await findInstallationFor(ctx, user, full));
  try {
    if (what === "branches") {
      const repo = await gh.repository(installationId, full);
      return json({ data: await gh.branches(installationId, full, repo.defaultBranch) });
    }
    if (what === "pulls") return json({ data: await gh.pulls(installationId, full) });
    return json({ data: await gh.issues(installationId, full) });
  } catch (err) {
    throw githubError(err, `read that repository's ${what}`);
  }
}

/**
 * Which of this person's installations can see a repository.
 *
 * Asked rather than remembered. Somebody with the App on a personal account
 * and two organisations has three, and the right one is a property of the
 * repository — storing the answer means being wrong the day a repository is
 * transferred.
 */
async function findInstallationFor(ctx: AppContext, user: UserRow, repo: string): Promise<number> {
  const gh = requireGitHub(ctx);
  const token = await userToken(ctx, user);
  let installations: { id: number }[];
  try {
    installations = await gh.installationsFor(token);
  } catch (err) {
    throw githubError(err, "find which of your installations can see that repository");
  }
  const owner = repo.split("/")[0]!.toLowerCase();
  for (const i of installations) {
    try {
      const found = await gh.repository(i.id, repo);
      if (found.fullName.toLowerCase() === repo.toLowerCase()) return i.id;
    } catch {
      /* this installation cannot see it; try the next */
    }
  }
  throw new HttpError(
    404,
    "no_installation",
    `Drydock cannot see ${repo}. Install the GitHub App on ${owner}, or add that repository to an installation you already have.`,
  );
}

function projectView(ctx: AppContext, p: ProjectRow, user: UserRow): Project {
  return {
    id: p.id,
    name: p.name,
    repo: p.repoFullName,
    repoPrivate: !!p.repoPrivate,
    defaultBranch: p.defaultBranch,
    repoPath: p.repoFullName ? mountPathFor(p.repoFullName) : null,
    runtime: p.runtime,
    model: p.model,
    rev: p.rev,
    createdAt: p.createdAt,
    ownerLogin: user.login,
    openThreads: ctx.db.threadsOf(p.id).length,
  };
}

/** The picker's answer, as the thing `spec.ts` understands. */
function readOrigin(raw: Partial<ThreadOrigin> | undefined, project: ProjectRow): Origin {
  const fallback = project.defaultBranch ?? "main";
  if (!raw || !raw.kind || raw.kind === "blank") {
    return project.repoFullName ? { kind: "branch", base: fallback } : { kind: "blank" };
  }
  const base = str(raw.base, 250).trim() || fallback;
  if (raw.kind === "pr" && raw.number) return { kind: "pr", base, number: Number(raw.number), title: str(raw.title, 250) };
  if (raw.kind === "issue" && raw.number) return { kind: "issue", base, number: Number(raw.number), title: str(raw.title, 250) };
  return { kind: "branch", base };
}

/** Only the two managers Fountain installs; anything else is stored and ignored. */
function cleanPackages(raw: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = { apt: [], npm: [] };
  for (const manager of ["apt", "npm"] as const) {
    const list = Array.isArray(raw[manager]) ? raw[manager]! : [];
    out[manager] = [...new Set(list.map((s) => String(s).trim()).filter((s) => /^[\w.@/+-]{1,80}$/.test(s)))].slice(0, 60);
  }
  return out;
}

/**
 * The built SPA, with everything unknown falling through to `index.html` so
 * client-side routing survives a reload. Absent in development, where Vite
 * serves the app and proxies `/api` here.
 */
async function serveStatic(ctx: AppContext, path: string): Promise<Response> {
  if (!ctx.config.staticDir) return new Response("Not found\n", { status: 404 });
  const safe = path.replace(/\.\.+/g, "").replace(/^\/+/, "");
  const direct = safe ? Bun.file(`${ctx.config.staticDir}/${safe}`) : null;
  if (direct && (await direct.exists())) return new Response(direct);
  const index = Bun.file(`${ctx.config.staticDir}/index.html`);
  if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("Not found\n", { status: 404 });
}
