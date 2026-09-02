# Repo Sage

Chat with any public GitHub codebase: point it at a repo, and a sage — an
agent on its own computer — clones it, maps it, and answers your questions
with file-and-line citations that link straight back to GitHub. Watching it
grep is half the demo.

It is a static single-page app with no backend of its own — it talks only to
the [Fountain](https://github.com/BinaryBourbon/fountain) API, where each sage
runs as a teammate (an agent in a sandbox with a real shell and a real git).
Client patterns (OAuth, SSE, API client) follow
[dns-desk](https://github.com/managoat/dns-desk) /
[fountain-team](https://github.com/managoat/fountain-team).

## Run it

```bash
bun install
bun run dev        # http://localhost:5175
```

On first load, enter your Fountain URL and **Sign in with Fountain** (OAuth
code + PKCE; the token is an API key), or paste an API key. Then name a repo —
`owner/name` or a GitHub URL, public repos only. The app hires one sage per
repo (an agent named `Sage: owner/name`, added to your team), sends it off to
study, and remembers the pairing per Fountain URL in this browser.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5175     # or wherever you host the build

# only for "Sign in with Fountain" — JSON, redirect URIs match exactly:
OAUTH_CLIENTS='[{"id":"repo-sage","name":"Repo Sage","redirect_uris":["http://localhost:5175/"]}]'
```

The production deployment at `repo-sage.demo.managoat.com` needs the same two
entries with `https://repo-sage.demo.managoat.com` / `https://repo-sage.demo.managoat.com/`.

## How it works: the sage protocol

The app and the agent share two fenced blocks, parsed out of the agent's
replies (`src/lib/protocol.ts`; the agent's side of the contract is
`src/lib/spec.ts` — change one, change both).

On its first message the sage shallow-clones the repo (it will decline one
that is too big, and will say so if the repo is missing or private — no map,
just an error state with a retry). Then it reports the dossier:

    ```repo-map
    {"repo":"owner/name","default_branch":"main","description":"…",
     "languages":[{"name":"Elixir","share":0.8}],"loc":12345,
     "components":[{"name":"router","path":"lib/web/router.ex","role":"…"}],
     "entry_points":["lib/app.ex"],"how_it_works":"one paragraph"}
    ```

The app renders that as the dossier header — language bar, component cards
(click → GitHub), the paragraph. Every substantive answer afterwards ends
with its evidence:

    ```citations
    [{"path":"lib/web/router.ex","start":14,"end":29,"why":"the route in question"}]
    ```

Citations become cards under the answer, each deep-linking to
`github.com/<repo>/blob/<branch>/<path>#L<start>-L<end>` (lines may be absent —
the link degrades to a single line or the whole file). Inline `path:line`
mentions in the prose are linkified against the same repo.

The conversation is the system of record: the dossier and every answer are
derived from turns + blocks on load and from one `/api/team/stream` SSE
connection while live. The clone persists on the sage's computer between
questions — new questions never re-clone.

## Development

```bash
bun test           # protocol, GitHub links, ACP block parsing, SSE, render smoke
bun run typecheck
bun run build      # tsc + vite
```

To work on the UI without a live Fountain, run the mock (`bun run mock`),
start the app through the dev proxy
(`FOUNTAIN_PROXY=http://localhost:8788 bun run dev`), and enter
`http://localhost:5175` as the Fountain URL with any string as the API key —
you land on a sage that has already studied a repo, with an answered question.

No state outside the browser: settings in `localStorage`
(`repo-sage.settings`), the repo → sage pairings per Fountain URL
(`repo-sage.repos`).

## License

MIT
