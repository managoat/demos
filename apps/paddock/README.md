# Paddock

**paddock.demo.managoat.com** — a computer in the cloud that stays yours, on
the [Fountain](https://github.com/BinaryBourbon/fountain) API.

Sign in, pick a runtime, and you have a machine. Terminal tabs are threads on
it. Everything you change about it afterwards — repositories, packages, a setup
script, secrets, MCP servers, skills — is changed **on** the machine rather
than by replacing it, and the app is explicit at every point about whether a
change has actually landed.

Invite people in — by email, or by a link that needs no account at all. They
use your machine and you pay for it.

A React SPA over a Bun server. The server holds your Fountain key, because it
has to: see *Why there is a server* below. Client patterns (OAuth, SSE) follow
[dns-desk](../dns-desk); the tab model is [fountain-team](../fountain-team)'s
threads with a different front end; the guest proxy and key custody are
[salon](../salon)'s, adapted from one conversation to a whole machine.

## Run it

Three processes: a Fountain, the Paddock server, and Vite. The mock is a real
enough Fountain to run the whole thing offline — it simulates the box, receipt
included, so the declare → pending → apply → applied loop actually works:

```bash
bun install
bun run mock                                       # a fake Fountain on :8792
FOUNTAIN_URL=http://localhost:8792 bun run server  # the Paddock server on :8080
bun run dev                                        # the SPA on :5182
```

Then paste any non-empty key. Against a real Fountain, drop `FOUNTAIN_URL` (it
defaults to `https://managoat.com`) and skip the mock.

Fountain-side, only sign-in needs registering — the browser no longer calls
Fountain directly, so no CORS origin is required:

```
OAUTH_CLIENTS='[{"id":"paddock","name":"Paddock","redirect_uris":["http://localhost:5182/"]}]'
```

The server takes `FOUNTAIN_URL`, `DATA_DIR`, `PADDOCK_SECRET` (encrypts stored
keys; generated into `DATA_DIR/secret` if unset), `PUBLIC_URL` (where invite
links point) and `STATIC_DIR`.

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

## Sharing a machine

**Invite by email** and they sign in with Fountain; **invite by link** and
anyone who opens it is in, with no account, no sign-in and nothing to install.
Either way the turns run on your key and you pay for them.

A guest is a way in, not a place to stay: anonymous, one terminal, on somebody
else's credit, and gone when that link is re-minted. Signing in from inside the
app fixes all four at once — the seat becomes a real membership under their own
name, a re-mint no longer evicts them, their turns say who sent them, and they
get a machine of their own. The offer sits beside the other panels rather than
behind a menu, and the server does the conversion on the sign-in itself, so it
cannot half-happen.

**An invitation is to a terminal, not to the machine.** Somebody let into
Terminal 2 gets Terminal 2: they do not see your other terminals, cannot open
one, and cannot change what is installed. Each terminal has its own link, and
closing one leaves the others alone.

The link is the credential, so **a new link is the revoke**: minting one evicts
every guest who came in on the old one, mid-session, from that terminal only.
Closing a terminal ends it for everybody in it — which is the other way to take
an invitation back, and why only you can do it.

### What sharing actually costs

Per-terminal invitations narrow what you hand out, but not to nothing: a
terminal is a shell on the machine, so anyone who can type into one can ask the
agent to print your environment secrets or read the disk. What they cannot do
is see your *other* conversations. No permission model closes the rest, because
the agent is the thing holding the shell — so the invite dialog says so where
the decision is being made rather than in this file.

The one real mitigation is the distinction the Machine panel already draws: an
**environment** secret is an env var inside the box and a guest can read it; a
**vault** secret never touches the box at all, because the egress broker
substitutes it in flight. Once other people are in your paddock, that is where
anything sensitive belongs.

## Why there is a server

Phase 1 had none: the browser held your key and talked to Fountain directly,
and the app had no privileged access to anything.

Sharing ends that, and not by choice. Sandbox identity is
`(user, agent, environment, vault)` — the **user** is in it — so a guest's own
Fountain account can never attach to your box. Their turns have to run on your
key, so something has to hold your key, so paddock now holds it: AES-256-GCM
under `PADDOCK_SECRET`, sessions stored as hashes, in `server/crypto.ts`.

What guards it instead is `server/proxy.ts`, and it is worth reading before
trusting any of this. Everything is an allowlist: tabs are derived with the
same `shared/tabs.ts` the client renders the strip with (one function, both
sides, so they cannot disagree); the ops tab — the one paddock changes the
machine through — is excluded explicitly, because a guest who could prompt it
would route around every other rule by asking; reading the config is open to
the paddock and changing it is not; and even the owner gets a list of shapes
rather than "anything under `/api`", so a scripted browser cannot spend their
whole Fountain account.

`server/app.test.ts` is that boundary written down as fifteen ways in that stay
shut.

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

The Files panel is a file tree — expand directories in place, click a file to
read it, `git diff` beside it — over the same read-only routes. There is no write, and there will not be one: to change
something, ask for it in the tab. The panel says so rather than leaving people
hunting for an edit button that does not exist.

The terminal is a Claude Code prompt rendered as scrollback, not a PTY, for the
same reason. It does not pretend otherwise anywhere in the UI.

## The browser is the only way in

An earlier sketch had `paddock attach`, a script the app served so you could
drive a tab from your own terminal. It is not being built, and the reason is
the same fact that shapes everything else here: Fountain has no exec. A CLI
could only ever have opened the same conversation and rendered the same ACP
stream somewhere else — the same session with a different front end, not a
shell, however much the name suggested one.

That is a fair amount of surface for a second way to do the thing this app
already does, so there is one way in and it is honest about what it is.
