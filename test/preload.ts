/**
 * A document for the test run. Bun has no DOM of its own, so without this a
 * component can only be rendered to a string once — which never runs an
 * effect, fires an event, or renders a second time — and a hook cannot be run
 * at all. happy-dom puts `window` and `document` on the global before any test
 * file loads; test/render.tsx mounts into them.
 *
 * The catch is that happy-dom does not stop at the document: it replaces the
 * whole request stack on the way past, and that stack is not the one the
 * server tests want. server/app.test.ts stands up a real Bun.serve as a fake
 * Fountain and hands real Requests to the route table, and the two
 * implementations do not mix — Bun's fetch rejects happy-dom's AbortSignal
 * outright ("signal is not of type AbortSignal", which is server/proxy.ts's
 * event stream, on Bun 1.4). So everything on the fetch–abort–stream path goes
 * back to Bun's after registration.
 *
 * Nothing under src/ wants happy-dom's version of those. Everything that is
 * about a document — the event classes, the timers, Blob/File and the
 * FileReader that reads them — stays happy-dom's, because its own DOM is built
 * on them and mixing there breaks the other way.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const BUNS = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "WebSocket",
  "AbortController",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "URL",
  "URLSearchParams",
] as const;

const globals = globalThis as unknown as Record<string, unknown>;
const native = new Map(BUNS.map((name) => [name, globals[name]] as const));

GlobalRegistrator.register({ url: "http://localhost/" });

for (const [name, value] of native) if (value !== undefined) globals[name] = value;

// React only allows `act` — and so the render helpers — when this is set.
globals.IS_REACT_ACT_ENVIRONMENT = true;
