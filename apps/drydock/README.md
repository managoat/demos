# Drydock

**drydock.demo.managoat.com** — [Conductor](https://conductor.build), for
machines in the cloud, on the [Fountain](https://github.com/BinaryBourbon/fountain) API.

Sign in with GitHub, pick a repository, and open a **thread**. The thread gets a
machine of its own with a fresh clone on it, a branch to push from, an agent
working in it, and a **real terminal** — a PTY, not a transcript. Open four
threads and you have four machines. Close one and its machine goes with it.

A React SPA over a Bun server. The server holds the Fountain key, the GitHub
App's private key and the Sprites token; the browser holds none of them. See
*Whose account is this* below, because that is the trade this app makes and it
is not a small one.

## Run it

Three processes. The mock is a real enough Fountain *and* GitHub to run
everything offline — including sign-in, which is the half a fixture cannot fake:

```bash
bun install
bun run mock                                       # a fake Fountain + GitHub on :8793

FOUNTAIN_URL=http://localhost:8793 FOUNTAIN_API_KEY=mock \
GITHUB_API_URL=http://localhost:8793/github GITHUB_WEB_URL=http://localhost:8793/github \
GITHUB_APP_ID=1 GITHUB_APP_SLUG=drydock \
GITHUB_OAUTH_CLIENT_ID=cid GITHUB_OAUTH_CLIENT_SECRET=sec \
GITHUB_APP_PRIVATE_KEY="$(openssl genrsa 2048)" \
DRYDOCK_SECRET=dev-secret-at-least-16 PUBLIC_URL=http://localhost:8081 \
bun run server                                     # the Drydock server on :8081

bun run dev                                        # the SPA on :5183
```

The mock builds a machine in four seconds and finishes a turn in two and a half
(`MOCK_BUILD_MS`, `MOCK_TURN_MS`), so the *waiting* states — the ones a person
spends the first minute of every thread looking at — are what you develop
against rather than what you find out about in production.

Against a real Fountain, drop `FOUNTAIN_URL`, `GITHUB_API_URL` and
`GITHUB_WEB_URL` and supply a real App. **Nothing needs registering at
Fountain**: the browser never calls it, so there is no OAuth client and no CORS
origin — the one piece of deployment paperwork every other app in this suite
needs, and the only thing this app's architecture buys back.

## The mapping, which is the whole design

Conductor is a Mac app. It makes you a **project** from a folder, and a
**thread** inside it is a `git worktree` — a second checkout of the same
repository, so two pieces of work do not tread on each other. Everything else
follows from having a real computer underneath.

There is no folder here, so the question is what plays the part of the worktree.
Fountain's answer is better than a worktree, and it is the reason this app is
worth building:

| Conductor | Drydock |
| --- | --- |
| Project — a folder plus the agent that works on it | one Fountain **agent**, **environment** and **vault**, written once and never replaced |
| Thread — a `git worktree` beside the main checkout | one **conversation** with `sandbox_mode: "ephemeral"` — its own machine, built from the project's environment and reclaimed with it |
| The repository, cloned once | a `repositories[]` entry on the environment, so **every machine arrives already cloned** |
| Terminal | a PTY over the Sprites exec WebSocket, proxied by this server |

### Why the project is exactly three records

A Fountain sandbox's identity is `(user, agent, environment, vault)` — by id.
Change any of those ids and the machine built from them is a different machine.
So a project keeps **one** of each, made the first time and mutated in place
forever after. Every setting drydock offers is an edit to one of those three
records; nothing replaces one. `server/projects.ts` is the whole of that rule.

### Why a thread gets a whole machine

Because it is the strongest isolation on offer and it costs nothing to take.

Paddock — this suite's other long-lived-machine app — puts every terminal tab
on **one** persistent box, and pays for it in a system prompt that spends three
paragraphs telling an agent not to touch the other tabs' work. That rule is
enforced by asking nicely. Here there is nothing to ask: two threads share
their configuration and share no disk, so a thread cannot damage another
thread's checkout, cannot leave a dirty index in one, and cannot hold the
branch another one wants.

It also makes settings honest for free. Paddock had to invent a whole
declare → pending → apply → verify protocol so that editing the setup script
could reach a machine that was already running. Here, editing the setup script
lands on the next thread, because the next thread is a new machine. There is
nothing to apply and nothing to verify.

The trade is real and the UI says so where it costs something:

- **The first minute is spent building.** A fresh clone of a large repository
  is not instant. `ThreadStatus` has a separate `building` state rather than
  folding it into `running`, because "cloning your repository" and "the agent
  is thinking" are different sentences and a spinner that means both is a
  spinner that means neither.
- **What survives is what you pushed.** The machine goes when the thread does.
  The Checks panel says this in as many words at exactly the moment it matters
  — when you are looking at a branch that exists nowhere but the machine.

### Why the first turn is written by the app

Which branch a thread is on is a fact about the thread, not about the project,
so it cannot live in the environment. It has to be done *on* the machine, and
Fountain has exactly one way to do anything on a machine: send a prompt.

So the opening turn is `shared/spec.ts`'s `bootstrapPrompt` — a script, not a
description. It checks out the branch and writes `~/.drydock/thread.json` with
what actually happened: the branch `git rev-parse` reports, the sha, the file
count `git ls-files` counted. Drydock reads that file back over
`GET /api/sandboxes/:id/file` and renders it as the card above the transcript:

> You're in a new copy of managoat/demos called osaka
> Branched `mock/osaka` from `main`
> Created `/workspace/demos` and copied 1,480 files

Every line of that card comes from the machine. Nothing on it is predicted from
what was asked for, which is the entire reason it is worth showing — and why a
thread whose first turn has not finished renders "setting up" rather than a card
full of hopeful defaults.

An unreadable receipt is *not* a failure. It is a turn that has not finished, a
machine that is parked, or an agent that wrote prose instead of JSON, and all
four render the same way.

## The terminal is real

Fountain has no exec, deliberately: *there is no request that runs a command; to
run a command, send a prompt.* That is the right boundary for Fountain, and it
is why paddock's terminal is a Claude Code prompt rendered as scrollback.

Drydock goes one layer down. Fountain's sandboxes run on
[Sprites](https://sprites.dev), and every sandbox reports its `sprite_name` — so
a server holding a Sprites token can reach the same machine directly. Exec there
is a WebSocket with a TTY mode, so the Terminal panel is a login shell: job
control, `vim`, `top`, all of it. `server/terminal.ts` bridges the browser's
socket to the sprite's, byte for byte.

Four things about that are worth knowing rather than discovering, and the UI
says all four:

1. **It is optional.** No `SPRITES_TOKEN`, no terminal — and everything else
   still works, because everything else goes through Fountain. The panel renders
   a designed empty state naming the variable.
2. **It is out of band.** These commands are not turns. They are not in the
   transcript, they do not wait for the agent's lock, and the conversation's own
   record does not know they happened. That is the feature — you can look around
   while the agent works — and it is also why the agent may be surprised by a
   file you moved.
3. **The blast radius is one thread.** Which is the whole reason threads get a
   machine each.
4. **The token is the platform's.** It never reaches a browser and is never
   written onto a sprite. The browser's socket carries a drydock session cookie
   and nothing else.

The wire format is not guessable and is written down at the top of
`server/sprites.ts`: one-byte stream ids per message in normal mode, no prefix
at all in TTY mode, JSON text frames for control, a **one**-byte exit code, and
a clean close with no exit frame meaning exit 0.

## Whose account is this

Every other app in this suite either hands the browser a Fountain key
(dns-desk, arena) or holds one key per signed-in person (paddock, salon).
Drydock holds exactly **one, for everybody**, because sign-in is GitHub and a
person here has no Fountain account to spend.

That is a real trade, stated plainly:

- Every machine anybody builds here runs on this deployment's Fountain balance.
- Isolation between people is drydock's own — `projectOf` and `threadOf` in
  `server/context.ts` select on `user_id` as well as id, so somebody else's
  project is **not found** rather than refused. Those two functions are the
  whole tenancy story and they are the only place it is enforced.
- A project's agent carries `allowed_vault_ids: [its own vault]`, so one
  project cannot reach another's secrets even though both live on one account.

What it buys is that the browser holds no credential for anything. There is no
proxy in this app and no forwarding: `server/app.ts` is a list of routes, and a
path not on that list is not reachable. That is a much easier property to check
than an allowlist — which is why paddock needs `server/proxy.ts` and this does
not.

## GitHub, in three roles

**Signing you in.** The App's OAuth client. No `scope` — scopes are an OAuth
*App* concept, and a GitHub App's user token gets what it can do from the
installation.

**Reading.** `GET /user/installations` with the *user's* token is the join that
matters: it returns exactly the installations that both the App has and this
person can see. Asking the App for its installations would list everybody who
has ever installed drydock.

**Cloning.** An installation token, narrowed twice — `repositories: [one]` and
`permissions: {contents, metadata, pull_requests, workflows}`, both intersected
with what the installation already grants. It is written into the project's
**vault** under `GITHUB_TOKEN` *and* `GH_TOKEN`, and named as the repository's
`secret_key` so Fountain's clone uses it as HTTPS `x-access-token` auth.

That narrowing is the most load-bearing thing in `server/github.ts`, and the
reason is three lines away in this README: **a thread has a shell on its
machine, and anyone who can type into it can read that machine's environment.**
An installation token for eleven repositories would be eleven repositories they
could read. One scoped to the one repository the thread is about is the
credential that matches the blast radius.

Where Fountain's egress broker is configured it is better still: `GITHUB_TOKEN`
and `GH_TOKEN` are both in the broker's catalog, so the machine holds
`__github_token__` and the broker substitutes the real value in flight. Without
a broker it is an ordinary vault secret on the box. The panel credits the broker
rather than the vault, because the vault is not what provides that.

Tokens live an hour and a thread's machine is built when the thread opens, so
`refreshCloneToken` re-mints into the vault before every build. A failure there
is not fatal: a public repository needs no token, and a revoked installation
should fail at the clone in GitHub's own words rather than here in ours.

## How the pieces map

Nothing about your work lives in this browser.

| It knows | From |
| --- | --- |
| who you are | a session cookie; the row is in drydock's database |
| which projects you have | rows, because a project's name and repo are drydock's ideas |
| which threads are open | rows, because a `channel_id` cannot say who made one or from what |
| whether a machine is up | Fountain, asked on every read |
| what is on the disk | Fountain's file, listing and diff routes |
| what the thread did | the receipt the machine wrote |
| whether the branch is pushed | GitHub |

`shared/spec.ts` and `shared/ids.ts` are the contract — what drydock asks a
machine for, how it reads the answer, and the four places one name is
load-bearing at once. They are the files the suite never shares, because they
are the product.

### One thing that is not there

There is no write to a file, and there will not be one. To change something, ask
for it in the thread — or use the terminal, which is a real shell and can do it.
The Files panel says so rather than leaving somebody hunting for an edit button.

## Deploy

Push to `main`. CI builds `ghcr.io/managoat/drydock` and pins the sha into
`k8s/deployment.yaml`; Flux reconciles it from
[jhgaylor/home-cloud](https://github.com/jhgaylor/home-cloud).

Unlike its siblings, this one's `drydock-secrets` is **not** `optional: true`.
Paddock and salon generate their own secret into the volume and degrade to a
working app; drydock cannot — with no Fountain key there are no machines, and
with no GitHub App there is no way to sign in. A pod that starts without the
Secret would serve a sign-in button that cannot work, so it does not start.
`k8s/infisicalsecret.yaml` lists what the folder holds.

## License

MIT — see [LICENSE](../../LICENSE).
