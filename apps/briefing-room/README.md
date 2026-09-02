# Briefing Room

Ask for a brief, get a brief. Tell it what you need to understand and why; a
researcher with its own computer goes and reads real sources on the open web,
and comes back with a clean, sourced document — not a chat transcript.

It is a static single-page app with no backend of its own — it talks only to
the [Fountain](https://github.com/BinaryBourbon/fountain) API, where the
researcher runs as a teammate (an agent in a sandbox with internet access; it
holds no credentials of yours). Client patterns (OAuth, SSE, API client)
follow [dns-desk](../dns-desk).

## Run it

```bash
bun install
bun run dev        # http://localhost:5175
```

On first load, enter your Fountain URL and **Sign in with Fountain** (OAuth
code + PKCE; the token is an API key), or paste an API key. Then either pick a
teammate already running the `briefing-room` agent, or let the app hire one:
it creates the agent with the built-in operating rules and adds it to your
team. No vault, no environment — the researcher only reads the public web.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5175     # or wherever you host the build

# only for "Sign in with Fountain" — JSON, redirect URIs match exactly:
OAUTH_CLIENTS='[{"id":"briefing-room","name":"Briefing Room","redirect_uris":["http://localhost:5175/"]}]'
```

(In production this app is served at `https://briefing-room.demo.managoat.com` — that
origin goes in `API_CORS_ORIGINS` and its redirect URI in `OAUTH_CLIENTS`.)

## How it works: the brief protocol

Commissioning is a form, not a chat: topic, "why / what decision is this
for", and depth (Quick scan / Standard / Deep dive — mapped to instructions
and source counts). The app composes the request message; the agent fetches
real pages with curl (search, follow links, read), and may never cite a page
it did not fetch. While it works, the app derives a calm progress pane from
the ACP tool calls — the URLs it is reading surface as they happen; the raw
commands never do.

The agent answers with exactly one fenced block, parsed out of its reply
(`src/lib/protocol.ts`; the agent's side of the contract is `src/lib/spec.ts`
— change one, change both):

    ```brief
    {"id":"brf-2c9e","title":"…","asked":"the request, restated",
     "tldr":["3–5 sentences, the answer itself"],
     "sections":[{"heading":"…","body_md":"…"}],
     "sources":[{"title":"…","url":"…","note":"what this backed"}],
     "caveats":["what it couldn't verify"],"depth":"standard",
     "written_at":"…"}
    ```

The app renders it as a document: title, TL;DR as a highlighted box, sections
with generous type, numbered sources (real links), caveats in a quiet
footnote. Print (⌘P) produces a clean handout. Under the brief, one input —
"Ask a follow-up or request a revision": a prose reply renders as an
**analyst's note**; a new `brief` block with the same id is a revision, shown
as version chips (v1/v2). A reply with no block at all renders as prose with
an "ask again for the full brief" button.

The conversation is the system of record. The library rail — every brief
ever produced, searchable, newest first — is folded from the conversation's
turns on load and kept live over one `GET /api/team/stream` SSE connection
(reconnecting with `Last-Event-ID`; the server's 60 s idle close is normal).
Nothing derived is stored anywhere else.

## Development

```bash
bun test           # protocol, markdown, ACP block parsing, SSE parsing, render smoke
bun run typecheck
bun run build      # tsc + vite
```

To work on the UI without a live Fountain, run the mock (`bun run mock`),
start the app through the dev proxy
(`FOUNTAIN_PROXY=http://localhost:8787 bun run dev`), open
`http://localhost:5175`, and paste any string as the API key — you land on a
library with a brief, an analyst's note, and a revision.

No state outside the browser: settings in `localStorage`
(`briefing-room.settings`), the chosen teammate per Fountain URL
(`briefing-room.analyst`).

## License

MIT
