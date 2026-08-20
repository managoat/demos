# Table Talk

Drop a spreadsheet, get charts and plain-English insights, then just keep
asking questions. The analyst is an agent with a real computer: it saves your
CSV to disk, works it over with Python, and answers like a smart friend — no
jargon, no dashboards to configure.

It is a static single-page app with no backend of its own — it talks only to
the [Fountain](https://github.com/BinaryBourbon/fountain) API, where the
analyst runs as a teammate (an agent in a sandbox). Client patterns (OAuth,
SSE, API client) follow [dns-desk](https://github.com/jhgaylor/dns-desk).

## Run it

```bash
bun install
bun run dev        # http://localhost:5175
```

On first load, enter your Fountain URL and **Sign in with Fountain** (OAuth
code + PKCE; the token is an API key), or paste an API key. Then drop a CSV
(or paste one). The first **Analyze** hires the analyst for you: it creates a
`table-talk` agent with the built-in operating rules and adds it to your team;
after that it is reused.

The CSV is parsed locally first — preview table, row/column counts, a cap of
400 KB / 5,000 rows (truncated with a notice beyond that). Nothing leaves the
browser until you press Analyze.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5175     # or wherever you host the build

# only for "Sign in with Fountain" — JSON, redirect URIs match exactly:
OAUTH_CLIENTS='[{"id":"table-talk","name":"Table Talk","redirect_uris":["http://localhost:5175/"]}]'
```

(The hosted copy at `tables.inevitable.fyi` needs its origin in
`API_CORS_ORIGINS` and a `table-talk` client with
`https://tables.inevitable.fyi/` registered the same way.)

## How it works: the report protocol

Each dataset is one Fountain conversation — the analyst teammate gets a fresh
thread on the same computer per file, and the left rail is just a localStorage
index of conversation ids. **The conversation is the system of record**: the
app derives everything it shows from turns and the fenced blocks in them, on
load and over one team SSE stream while live.

The dataset travels to the agent as a ```` ```csv ```` fence inside the first
message; the agent saves it to disk, analyzes it with Python, and replies with
prose plus a block the app renders (`src/lib/protocol.ts`; the agent's side of
the contract is `src/lib/spec.ts` — change one, change both):

    ```table-report
    {"id":"rpt-1","title":"…","insights":["…"],
     "stats":{"rows":123,"columns":[{"name":"region","type":"category","distinct":4,"top":"west"}]},
     "charts":[{"type":"bar","title":"…","x":["west","east"],"series":[{"name":"revenue","y":[120,80]}]}]}
    ```

Insights become cards, `stats.columns` a column-profile strip, `charts`
hand-rolled SVG (bar, line, pie — no chart library). Follow-ups are plain
messages; the CSV stays on the agent's disk, so answers come back fast, with
optional further `table-report` blocks appended as new sections. Each report
carries a collapsed "how I got this" — the tool calls the analyst ran, parsed
from the ACP stream (`src/lib/acp.ts`).

## Development

```bash
bun test           # csv parser, protocol, ACP block parsing, SSE parsing, render smoke
bun run typecheck
bun run build      # tsc + vite
```

To work on the UI without a live Fountain, run the mock (`bun run mock`),
start the app through the dev proxy
(`FOUNTAIN_PROXY=http://localhost:8788 bun run dev`), and open
`http://localhost:5175/dev-seed.html` once to point the app at it — you land
on an analyzed dataset with every chart kind on screen.

No state outside the browser: settings in `localStorage`
(`table-talk.settings`), the analyst per Fountain URL (`table-talk.analyst`),
the dataset index (`table-talk.datasets`).

## License

MIT
