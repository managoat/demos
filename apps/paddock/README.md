# Paddock

**paddock.demo.managoat.com** — a computer in the cloud that stays yours, on
the [Fountain](https://github.com/BinaryBourbon/fountain) API.

Sign in and you have a machine. Terminal tabs are threads on it. Everything you
change about it afterwards — repositories, packages, a setup script, secrets,
MCP servers, skills — is changed **on** the machine rather than by replacing
it, and the app is explicit at every point about whether a change has actually
landed.

Want a second one — a different checkout, a different set of secrets, something
you would rather not have next to your real work? Add a computer. It is a
separate box with its own disk, and the sidebar switches between them.

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

It also takes `SKILLS_URL`, which defaults to skills.sh. The mock serves the
same shape, so pointing it there makes the Skills search work offline like
everything else:

```bash
SKILLS_URL=http://localhost:8792/api/skills/search \
FOUNTAIN_URL=http://localhost:8792 bun run server
```

Worth doing even online: the real index answers in two to eight seconds when it
answers at all, and times out about half the time.

## The problem it exists for

Fountain builds a machine from an identity: `(user, agent, environment, vault)`,
by id. Change any of those ids and the machine you were using no longer matches
— `sandbox_identity_mismatch` — and you get a new one. For a demo of a fleet
that is fine. For a computer somebody *lives* on it is not: nobody accepts
losing their box because they added a package.

So each computer keeps exactly **one** agent, **one** environment and **one**
vault, made the first time it is opened and never replaced. Every setting
paddock offers is a mutation of one of those three records, in place. The ids
never move, the identity always matches, and no configuration change can take
the machine away.

The same fact is what makes a second computer a *computer* rather than a tab: a
different agent is a different identity is a different box. Adding one is
therefore not a special case of anything — it is the ordinary first run, again.

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
revision it opened at in its `channel_id` (`paddock:<computer>/t2@r7`), and a
tab behind the current one is badged *older settings*. Nothing is stored to
work this out and nothing can get it wrong.

**What goes in the two boxes comes from a catalog, not from memory.** MCP
servers are `GET /api/catalog`'s `mcp_servers` — the remote servers whose
authorization chain Fountain watched complete, with the date it last checked.
A chip says which of three states a server is in, and the difference is the
whole point: *connected* means the owner has authorized it and adding it names
that connection, so the egress broker attaches the token in flight and the box
never holds it; *connect ↗* means it has not been authorized, and the link goes
to Fountain, because connecting needs a browser session there and this app is
not it. Paddock reads connections and never creates one — that is account-level
state, and this app's authority stops at one machine.

Skills have no Fountain catalog ("Fountain curates no list"), so the search box
is [skills.sh](https://skills.sh), which is also the CLI Fountain shells out to
on the box. It goes through this server rather than the browser because
skills.sh sends no CORS header. The panel labels it as somebody else's list,
and says the thing that follows from that: adding one runs its installer on
your machine.

A skill is an object — `{source, ref?, name?}` from GitHub, or `{name, content}`
written here — and `name` on a GitHub entry *selects* one skill out of a
repository holding dozens rather than renaming it. Without a `ref`, Fountain
resolves the default branch when a tab opens, so two tabs a week apart can
install different code.

### One turn at a time

A box runs one turn at a time (`sandbox_at_capacity`). That is not an error
condition, it is the shape of owning one computer, so the prompt line says
which tab has the machine and queues behind it. The queued line sends itself
when the box frees up.

## More than one computer

**New computer** in the sidebar. It makes a database row and nothing else —
no agent, no environment, no vault, no sandbox — and the machine itself is
built by the browser the moment you land on it, down the same path first run
has always taken. A computer you make and never open costs nothing.

They are separate in the way that matters: separate disks, separate declared
packages and repositories, separate secrets, separate terminals, separate
people invited to them. Nothing crosses. **Start over** empties one and leaves
it; **Remove** takes the computer with it, and is offered only when you have
another to go back to, because an account always has a computer.

The name is yours and stays in this app's database. It never reaches Fountain,
and somebody you invited to a terminal never sees it — they were lent a
terminal, not shown around your account.

### How one is told from another

Everything else here is derived from Fountain rather than stored, and adding a
second machine had to not break that. The obvious approach — a table saying
which agent belongs to which computer — is a second copy of a fact, and this
app's whole argument is that a second copy is a bug waiting for the day the two
disagree.

So the computer rides in the `channel_id` alongside the slug and the revision:
`paddock:<computer>/t2@r7`. Which tabs are on which machine is then a question
the conversation list alone answers, for the browser and the server both, with
nothing to keep in sync and nothing to go stale. `shared/tabs.ts` still holds
the one implementation of it, and `belongsTo` is the whole of the new rule.

Channels written before any of this exist and name no computer. They belong to
the account's **original** computer — its oldest row — and only to that one, so
an existing machine stays exactly where it is and a computer added afterwards
can never inherit it. The same rule, one level up, decides which agent an
identity without a computer on it belongs to. Nobody loses a box to a deploy.

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
closing one leaves the others alone. They do not see your other computers
either: the invitation names a terminal on one machine, and every route is
scoped to that machine before it is scoped to that tab.

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

The case that matters most is a private repository, and it works out better
than it sounds. Fountain's broker keeps a two-entry catalog — `GITHUB_TOKEN`
and `GH_TOKEN` — and a secret under one of those names is brokered with no
binding and no configuration at all. The sandbox holds `__github_token__`, the
clone URL is written with that placeholder, and the broker attaches git's real
`x-access-token` basic auth on the way out. So marking a repository **private**
in the Machine panel stores a `GITHUB_TOKEN`, names it in the repository's
`secret_key`, and the clone works with the token never on the machine — where
somebody you invited could have printed it.

Three things about that are worth knowing rather than discovering:

- **The name is load-bearing.** Only `GITHUB_TOKEN` and `GH_TOKEN` get git's
  basic-auth rule. A GitHub *connection* is brokered too, but under
  `GITHUB_ACCESS_TOKEN` and as a *bearer* — which git over HTTPS does not use.
  A connection gives the agent the GitHub API. It does not give it a checkout.
- **The broker is what protects it, not the vault.** `Broker.split` runs over
  the environment and vault secrets *merged*, so a catalog key gets the
  placeholder from either store. Paddock still puts it in the vault — that is
  where sensitive things belong, and a vault wins a key collision — but the
  panel credits the broker for the protection, because the vault does not
  provide it.
- **Without the broker there is none of this.** On a Fountain with no broker
  for you, it is an ordinary env var in the box, and the panel says so where
  you are typing the token rather than here.

There is no GitHub App and there will not be one. Fountain already owns that
layer — Connections, with a preset for your own GitHub OAuth app — and
connecting one needs a browser session at Fountain, so paddock could not own
the flow even if it wanted to. Salon has an App because each *participant* there
brings a repository from their own account; in a paddock only the owner adds
one, so an App would buy a repository picker and a worse credential than the
one above.

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

`server/app.test.ts` is that boundary written down as fifty-nine ways in that
stay shut. The newest of them are about the second machine: a guest of one
computer cannot see that another exists, a tab cannot be opened onto a computer
its channel does not name, and retiring one computer does not reach for
another's tabs or delete another's agent.

## How the pieces map

Nothing about your machine lives in this browser — sign in from another laptop
and it is all still there.

| It knows | From |
| --- | --- |
| which computers you have | rows in paddock's own database, and nothing else |
| which machine is one of them | the newest live conversation naming it (`findBox`, `belongsTo`) |
| which tabs are open | conversations on that sandbox naming that computer (`tabsOf`) |
| what is on the machine | the receipt the machine wrote (`lib/protocol.ts`) |
| which tabs are behind | the revision in each `channel_id` vs. the agent's |

`src/lib/spec.ts` and `src/lib/protocol.ts` are the contract — what paddock
asks the box for and how it reads the answer. They are the two files the suite
never shares, because they are the product. Change one, change both.

A tab's first turn makes its working directory under `~/work/<slug>` — a real
`git worktree` when the box has a repository, so two tabs can hold different
branches at once. It branches from the *first* repository; the rest are cloned
and left alone, and the panel says which one it is when there is more than one.

Repositories are cloned to `/workspace/<name>`, which is Fountain's convention
and, more to the point, where the bundled `fountain` skill — mounted into every
sandbox whatever you declare — tells the agent to look first. Paddock used
`/home/sprite/<name>` until it did not, and the agent on the box was being sent
to the wrong place by the one skill it always has.

## Files, and what is not there

The Files panel opens on **Changes**: the files `git diff` reports, one row
each, with the letter `git status --short` uses and the lines added and
removed. Below it is the tree — directories expand in place, and a file that
has changed carries the same letter where it sits. Clicking either opens the
file in a modal, on its diff when it has one, with the file itself a tab away
and both numbered by line.

The modal is why the tree gets the whole sidebar. This was a 170px tree beside
a 170px code pane inside a 360px inspector, too narrow to read a nested path
*or* a line of code. The file is worth the window and the tree is worth the
sidebar, so each got one.

`GET /api/sandboxes/:id/{files,file,diff}` is still all of it. The diff route
returns one string — every changed file concatenated, as git printed it — and
`src/lib/diff.ts` splits it per file and numbers the lines inside each hunk.
That parsing is where the awkward cases live: a rename with no hunks, a binary
with none either, `/dev/null` standing in for the side that does not exist,
and the `\ No newline at end of file` marker that makes a naive `+` counter
over-count. So it is pure, out of the component, and tested against literal
`git diff` output rather than a diff written to suit the parser.

There is no write, and there will not be one: to change something, ask for it
in the tab. The panel says so rather than leaving people hunting for an edit
button that does not exist.

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
