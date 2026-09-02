/**
 * Fails if this roster and managoat.com/built-with name different apps.
 *
 * Two hand-kept lists of the same twelve things is what retired the previous
 * version of this page: it ran three apps behind and nobody noticed, because
 * nothing was watching. This is the thing that watches. It runs in CI on every
 * push, so the gap between "an app was added over there" and "this page is
 * wrong" is one red build rather than however long until someone looks.
 *
 * Deliberately compares only the set of hosts, not the copy. Wording drifting
 * a little is fine; the roster being wrong is not.
 */
import { DEMOS, host } from "../src/roster.js";

const BUILT_WITH = "https://managoat.com/built-with";

const res = await fetch(BUILT_WITH);
if (!res.ok) {
  console.error(`could not fetch ${BUILT_WITH}: HTTP ${res.status}`);
  process.exit(2);
}
const html = await res.text();

const upstream = new Set(
  [...html.matchAll(/https:\/\/([a-z0-9-]+\.demo\.managoat\.com)/g)].map((m) => m[1]!),
);
const ours = new Set(DEMOS.map(host));

const missingHere = [...upstream].filter((h) => !ours.has(h)).sort();
const missingThere = [...ours].filter((h) => !upstream.has(h)).sort();

if (missingHere.length === 0 && missingThere.length === 0) {
  console.log(`in step with built-with: ${ours.size} apps`);
  process.exit(0);
}
if (missingHere.length) console.error(`on built-with but not in src/roster.ts:\n  ${missingHere.join("\n  ")}`);
if (missingThere.length) console.error(`in src/roster.ts but not on built-with:\n  ${missingThere.join("\n  ")}`);
process.exit(1);
