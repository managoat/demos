# managoat/demos

The Fountain demo suite. Seventeen apps, one per directory under `apps/`, each
served at `<name>.demo.managoat.com` and indexed at
[demo.managoat.com](https://demo.managoat.com).

They are small, production-shaped surfaces on the
[Fountain](https://github.com/BinaryBourbon/fountain) API — the thing each one
exists to show is that an app which hires agents, prompts them and renders
what they do is an ordinary web app with no privileged access.

| App | At | What it is |
| --- | --- | --- |
| [arena](apps/arena) | arena.demo.managoat.com | One prompt to several model brains, side by side, blind until you vote. |
| [briefing-room](apps/briefing-room) | briefing-room.demo.managoat.com | Commissioned research briefs with real sources. |
| [dns-desk](apps/dns-desk) | dns-desk.demo.managoat.com | The shape every other app here was cloned from. |
| [drydock](apps/drydock) | drydock.demo.managoat.com | Conductor for cloud machines: a thread is a repo clone on a machine of its own, with a real terminal. |
| [fountain-conversations](apps/fountain-conversations) | fountain-conversations.demo.managoat.com | A client for the conversations surface: chat, timeline and raw views. |
| [fountain-demos](apps/fountain-demos) | demo.managoat.com | The suite's own index, at the parent of every host it lists. |
| [fountain-team](apps/fountain-team) | fountain-team.demo.managoat.com | Your agents as teammates in a messaging app. |
| [fountain-workbench](apps/fountain-workbench) | fountain-workbench.demo.managoat.com | Projects → work items → the agents pulled into them. Bun server. |
| [mend](apps/mend) | mend.demo.managoat.com | An audit of a public repo's CI, manifests and rulesets. Bun server. |
| [mission-control](apps/mission-control) | mission-control.demo.managoat.com | Plan, approve, fan out over a fleet of sandboxes. |
| [paddock](apps/paddock) | paddock.demo.managoat.com | A computer in the cloud that stays yours. Terminal tabs as threads on one box. Bun server. |
| [repo-sage](apps/repo-sage) | repo-sage.demo.managoat.com | Chat with any public GitHub repo, cited to file:line. |
| [rounds](apps/rounds) | rounds.demo.managoat.com | Mend's ambient sibling: repositories on a schedule. Bun server. |
| [salon](apps/salon) | salon.demo.managoat.com | Multiplayer chat — the host's Fountain account pays. Bun server. |
| [switchyard](apps/switchyard) | switchyard.demo.managoat.com | Parallel git worktrees on one machine. Sign in with GitHub; the server owns the Fountain account. Bun server. |
| [table-talk](apps/table-talk) | table-talk.demo.managoat.com | Drop a CSV, get charts and plain-English answers. |
| [watchtower](apps/watchtower) | watchtower.demo.managoat.com | Scheduled uptime, TLS and DNS patrols by an SRE teammate. |

The name is load-bearing in four places at once: it is the directory, the host
label, the OAuth client id registered on the Fountain server, and the image at
`ghcr.io/managoat/<name>`. One name per app, nothing to keep in step.

## Work on one

It is a single Bun workspace, so install once from anywhere:

```bash
bun install
bun run --cwd apps/arena dev      # or: cd apps/arena && bun run dev
```

Across everything:

```bash
bun run typecheck     # every app and package
bun run test          # every app and package, each in its own process
bun run build
bun run apps          # what is here
```

`bun run test` fans out rather than running one root `bun test` on purpose:
fountain-workbench's suite installs happy-dom's globals, and in a shared
process that changes what other suites see. See `scripts/each.ts`.

## Shared code

One app does not fit that sentence, and it is worth knowing before you read
it: **switchyard** signs people in with GitHub and runs every machine on the
*server's* Fountain account, so its browser holds no key at all. It is the one
place in the suite where the app has privileged access, and its README says
why and what that costs.

`packages/fountain-app` holds the four client libs every app was cloned with —
the SSE reader, the ACP log parser, the settings store and PKCE sign-in. Each
app keeps a short `src/lib/<name>.ts` that binds its own id and re-exports, so
imports inside an app read exactly as they did when it was its own repository,
and its `localStorage` keys are unchanged.

Two apps deliberately keep their own copy, and both say so in the file:
fountain-team's ACP parser also reads `session/request_permission`, and
salon's `settings.ts` is chat settings rather than the credential store.

What is *not* shared: each app's `spec.ts` and `protocol.ts`. Those are the
prompt contract — what the app asks the agent for and how it reads the answer
back — and being different per app is the point.

## Deploy

Push to `main`. `.github/workflows/build.yml` works out which apps the push
actually touched (`scripts/changed.ts` — an app's own directory rebuilds that
app; anything under `packages/` or the root toolchain rebuilds all of them),
builds and pushes multi-arch images to `ghcr.io/managoat/<name>`, then pins
the immutable sha tags into each `apps/<name>/k8s/deployment.yaml` in **one**
commit. Flux in [jhgaylor/home-cloud](https://github.com/jhgaylor/home-cloud)
reconciles one `GitRepository` over this repo with a `Kustomization` per app
pointed at `apps/<name>/k8s`.

Adding an app means: a directory under `apps/`, a `Dockerfile` and `k8s/`
beside it, a `Kustomization` in home-cloud's `chant/src/apps.ts`, an entry in
`apps/fountain-demos/src/roster.ts`, and the client id registered on the
Fountain server. CI's drift check fails if the index and `apps/` disagree.

## History

These were fourteen separate repositories until they were merged here as
subtree merges, so every commit is preserved and `git blame` still points at
the change that wrote a line. Path-scoped log needs `--full-history` to cross
the merge:

```bash
git log --full-history -- apps/arena/src/lib/spec.ts
```

The fourteen old repositories are archived, each pointing here from its
description. Their image tags (`ghcr.io/managoat/<name>:sha-<commit>`) still
name commits that exist in this repository — which is why the merge preserved
the original SHAs rather than rewriting them, and why those packages were kept
rather than recreated.

## License

MIT — see [LICENSE](LICENSE).
