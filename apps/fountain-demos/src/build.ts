/**
 * Renders dist/index.html from the roster. No framework and no client-side
 * JavaScript: the page is a list of links, and a list of links does not need a
 * runtime. `bun run build` is the whole pipeline.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { DEMOS, host, source, url, type Demo } from "./roster.js";

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const card = (d: Demo) => `        <li class="card">
          <a class="card-open" href="${url(d)}">
            <span class="glyph" aria-hidden="true">${escape(d.glyph)}</span>
            <h2>${escape(d.name)}</h2>
            <p>${escape(d.blurb)}</p>
            <span class="host">${escape(host(d))}</span>
          </a>
          <a class="source" href="${source(d)}">Source</a>
        </li>`;

export const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Managoat demos</title>
<meta name="description" content="${DEMOS.length} apps built on the Managoat API, each on its own origin, all open source and all running right now.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>%F0%9F%90%90</text></svg>">
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfaf8; --fg: #1b1a17; --muted: #6b6862;
  --card: #ffffff; --line: #e6e2db; --accent: #7a4a1e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16151300; --bg: #161513; --fg: #ece8e1; --muted: #9a948a;
    --card: #1f1e1b; --line: #2e2c28; --accent: #d9a066;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 60rem; margin: 0 auto; padding: 4rem 1.25rem 5rem; }
header { margin-bottom: 2.5rem; }
h1 { font-size: clamp(1.9rem, 5vw, 2.6rem); line-height: 1.1; margin: 0 0 .6rem; letter-spacing: -0.02em; }
.lede { margin: 0; color: var(--muted); max-width: 44rem; }
.lede a { color: var(--accent); }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem;
     grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); }
.card { position: relative; background: var(--card); border: 1px solid var(--line);
        border-radius: 12px; transition: border-color .15s, transform .15s; }
.card:hover { border-color: var(--accent); transform: translateY(-2px); }
.card-open { display: block; padding: 1.15rem 1.15rem 2.6rem; color: inherit; text-decoration: none; }
.glyph { font-size: 1.5rem; line-height: 1; }
h2 { font-size: 1.05rem; margin: .5rem 0 .35rem; letter-spacing: -0.01em; }
.card p { margin: 0 0 .8rem; color: var(--muted); font-size: .9rem; }
.host { font: .78rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); word-break: break-all; }
.source { position: absolute; right: 1.15rem; bottom: .9rem; font-size: .78rem;
          color: var(--muted); text-decoration: none; border-bottom: 1px solid var(--line); }
.source:hover { color: var(--fg); border-color: var(--accent); }
footer { margin-top: 3rem; color: var(--muted); font-size: .88rem; }
footer a { color: var(--accent); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>The Managoat demos</h1>
      <p class="lede">${DEMOS.length} apps on one API. Most have no backend of their own — static
      files in a browser, the API, and an agent with a real computer. Open one, point it at your
      Managoat server, sign in. It runs against your agents and your credit; nothing of yours
      reaches whoever wrote it. Longer write-ups on
      <a href="https://managoat.com/built-with">managoat.com/built-with</a>.</p>
    </header>
    <main>
      <ul>
${DEMOS.map(card).join("\n")}
      </ul>
    </main>
    <footer>
      Built on <a href="https://managoat.com">Managoat</a>. Every one of them is open source, under
      <a href="https://github.com/managoat">github.com/managoat</a>.
    </footer>
  </div>
</body>
</html>
`;

if (import.meta.main) {
  await mkdir("dist", { recursive: true });
  await writeFile("dist/index.html", page());
  console.log(`dist/index.html — ${DEMOS.length} demos`);
}
