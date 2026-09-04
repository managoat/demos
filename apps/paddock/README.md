# Paddock

**paddock.demo.managoat.com** — a computer in the cloud that stays yours, on
the [Fountain](https://github.com/BinaryBourbon/fountain) API.

Sign in, pick a runtime, and you have a machine. Terminal tabs are threads on
it. Everything you change about it afterwards — repositories, packages, a setup
script, secrets, MCP servers, skills — is changed **on** the machine rather
than by replacing it, and the app is explicit at every point about whether a
change has actually landed.

It is a static single-page app with no backend of its own; it talks only to
Fountain, on your key. Client patterns (OAuth, SSE, API client) follow
[dns-desk](../dns-desk); the tab model is
[fountain-team](../fountain-team)'s threads with a different front end.

## Run it

```bash
bun install
bun run dev        # http://localhost:5182
```

Without a Fountain to point at, run the mock — it simulates the box, including
writing the receipt, so the whole declare → pending → apply → applied loop
works offline:

```bash
bun run mock                                   # a fake Fountain on :8792
FOUNTAIN_PROXY=http://localhost:8792 bun run dev
```

Then enter `http://localhost:5182` as the Fountain URL and paste any non-empty
key.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5182     # or wherever you host the build

# only for "Sign in with Fountain" — JSON, redirect URIs match exactly:
OAUTH_CLIENTS='[{"id":"paddock","name":"Paddock","redirect_uris":["http://localhost:5182/"]}]'
```

## The problem it exists for

Fountain builds a machine from an identity: `(user, agent, environment, vault)`,
by id. Change any of those ids and the machine you were using no longer matches
— `sandbox_identity_mismatch` — and you get a new one. For a demo of a fleet
that is fine. For a computer somebody *lives* on it is not: nobody accepts
losing their box because they added a package.

So paddock keeps exactly **one** agent, **one** environment and **one** vault,
made on first run and never replaced. Every setting it offers is a mutation of
one of those three records, in place. The ids never move, the identity always
matches, and no configuration change can take the machine away.

Which leaves the real question, and the thing the app is actually about:
changing the config is instant, and changing the *machine* is not. Fountain has
no way to run a command on a box from outside — deliberately; reads are free
and writes are turns. So paddock sorts every setting into the tier that says
when it genuinely takes effect, and never says "applied" on trust.

| Tier | What is in it | How it lands | How the app knows |
| --- | --- | --- | --- |
| **On the box** | repositories, packages, setup script | a turn, on demand | the machine's own receipt |
| **Next tab** | secrets, MCP servers, skills, the prompt | opening a tab | a revision stamped on each tab |
| **New machine** | the runtime | a rebuild | it is baked into the disk |

### On the box — verified, not assumed

The environment builds the disk, so editing it does nothing to a running
machine. The panel shows those rows as `pending` and offers **Apply**, which
sends one turn to a hidden ops tab: do these things, then write
`~/.paddock/applied.json` with the ids you finished. You watch it happen.

Paddock then reads that file back over `GET /api/sandboxes/:id/file` — free,
works whatever the tabs are doing, and it does not wake a parked box. A row is
`applied` because the machine said so, never because the app asked for it.
Ids are content-addressed (`pkg:ripgrep`, `setup:<hash of the script>`), so
editing the setup script produces a new id and the row goes back to `pending`
on its own.

An unreadable receipt is **not** an empty box. It reads as "the machine has not
reported", with a button that asks the box what it already has — because the
alternative, treating silence as emptiness, reinstalls the world.

### Next tab — the honest half-truth

Secrets, MCP servers and skills are injected by Fountain when a session starts.
They are real the moment you save them and they do not reach a tab that is
already open. So saving one bumps a revision on the agent, each tab carries the
revision it opened at in its `channel_id` (`paddock:t2@r7`), and a tab behind
the current one is badged *older settings*. Nothing is stored to work this out
and nothing can get it wrong.

### One turn at a time

A box runs one turn at a time (`sandbox_at_capacity`). That is not an error
condition, it is the shape of owning one computer, so the prompt line says
which tab has the machine and queues behind it. The queued line sends itself
when the box frees up.

## How the pieces map

Nothing about your machine lives in this browser — sign in from another laptop
and it is all still there.

| It knows | From |
| --- | --- |
| which machine is yours | the newest live paddock conversation's `sandbox_id` (`lib/tabs.ts`) |
| which tabs are open | conversations sharing that sandbox (`tabsOf`) |
| what is on the machine | the receipt the machine wrote (`lib/protocol.ts`) |
| which tabs are behind | the revision in each `channel_id` vs. the agent's |

`src/lib/spec.ts` and `src/lib/protocol.ts` are the contract — what paddock
asks the box for and how it reads the answer. They are the two files the suite
never shares, because they are the product. Change one, change both.

A tab's first turn makes its working directory under `~/work/<slug>` — a real
`git worktree` when the box has a repository, so two tabs can hold different
branches at once.

## Files, and what is not there

The Files panel browses the machine and shows `git diff`, over the same
read-only routes. There is no write, and there will not be one: to change
something, ask for it in the tab. The panel says so rather than leaving people
hunting for an edit button that does not exist.

The terminal is a Claude Code prompt rendered as scrollback, not a PTY, for the
same reason. It does not pretend otherwise anywhere in the UI.

## Not built yet

Both are designed and neither is stubbed in the UI — there are no dead buttons.

- **Collaboration** — invite by email or an anonymous link, host pays.
  [salon](../salon) has the whole pattern: guests never hold the host's key,
  their client points at a proxy admitting exactly one conversation. That is
  what would introduce a Bun server here; `src/api/client.ts` takes its base
  URL from settings, so it can be pointed at a proxy without touching call sites.
- **`paddock attach`** — a single-file script the app serves that opens the same
  conversation as a tab and streams it into your terminal. The same session
  with a different front end. It is not a shell, and it should not be sold as
  one; Fountain has no exec, so nothing honest can be.
