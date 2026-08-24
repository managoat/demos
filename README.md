# Fountain Workbench

A dev workstation on the [Fountain](https://github.com/BinaryBourbon/fountain) API.

**Projects → work items → teammates.** A project is an environment and a
vault — the computer its work gets. You work on "fix foo" in project Fountain,
pull teammates into it, and talk to each one. The team is simply your Fountain
agents; adding a teammate to a work item is picking an agent, and then you
prompt.

Each teammate's conversation gets its own computer. When a Fountain supports
it (ADR 0023, *one sandbox, many conversations*), "**+ Here**" on a computer
that is already up opens a second conversation with the same teammate on the
same machine: shared checkout and disk, separate transcript. Against an older
Fountain the button still works; the conversation starts on a new computer and
the app says so. The sandbox identity `(agent, environment, vault)` falls out
of the tree — same project, same agent — which is what makes sharing legal.

Hosted at **https://workbench.inevitable.fyi/** — sign in with any Fountain
that lists that origin in `API_CORS_ORIGINS` and registers the
`fountain-workbench` OAuth client.

## Deploy

`.github/workflows/build.yml` builds the bundle on the runner, packages it as
nginx + `dist/` (`Dockerfile`, multi-arch), pushes
`ghcr.io/jhgaylor/fountain-workbench:sha-<commit>` and pins that tag into
`k8s/deployment.yaml`. [home-cloud](https://github.com/jhgaylor/home-cloud)
runs a Flux `GitRepository` + `Kustomization` over `k8s/` (namespace,
Deployment, Service, Traefik IngressRoutes, cert-manager Certificate), so a
push to `main` is a deploy. The same shape as the other apps on
`*.inevitable.fyi`.

## How it stores things

Fountain has no project or work-item primitive, so the tree (projects with
their environment + vault, items with their teammates) lives in this browser's
`localStorage`. A conversation's membership
is recorded on the server in its `channel_id` as `workbench:<project>/<item>`,
which is what makes the tree recoverable: a fresh browser rebuilds every
project (with its environment and vault) and item (with its teammates) that
ever had a conversation from the conversation list alone; only names are
lost, and those get placeholders until edited.

The API is reached through [`@agentshit/fountain-sdk`](https://www.npmjs.com/package/@agentshit/fountain-sdk).
The one thing the SDK does not do for a browser is the user-wide event stream
with its `conversations` notice, so `src/lib/sse.ts` reads that one by hand.

## Develop

Bun is the toolchain.

```bash
bun install
bun run dev                          # http://localhost:5173, CORS from the server
FOUNTAIN_PROXY=https://fountain.inevitable.fyi bun run dev   # …or proxied; point the app at http://localhost:5173
bun test
bun run build
```

Sign-in options on the first screen: **Sign in with Fountain** (OAuth 2.0
authorization code + PKCE; the token is an ordinary Fountain API key you can
revoke under Account → API keys) or paste a key.

## Layout

```
src/
  App.tsx            sign-in gate, OAuth callback, route switch
  store.tsx          SDK client, conversation list, one SSE stream, the persisted tree
  router.ts          hash routes
  lib/workbench.ts   the model: projects, items, teammates; channel ids; reconcile
  lib/turns.ts       fold a log feed into turns for the chat view
  lib/blocks.ts      arrange server-parsed blocks (from fountain-conversations)
  lib/markdown.tsx   allow-list markdown → React nodes, no innerHTML
  pages/             Projects, Project, WorkItem, Team
  components/        Thread, StartDialog, EnvVaultFields, Blocks, Settings, Layout
```

## Licence

MIT.
