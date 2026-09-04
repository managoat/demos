/**
 * Fails if this roster, managoat.com/built-with, and the apps in this
 * repository do not all name the same set.
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
import { readdirSync } from "node:fs";
import { DEMOS, host } from "../src/roster.js";

const BUILT_WITH = "https://managoat.com/built-with";

/**
 * The third list, and the only one that cannot lie: the app directories in
 * this repository. It was not available while these were fourteen separate
 * repos, and it catches the case the built-with fetch never could — an app
 * added to the suite and to nothing else. Checked first, and without the
 * network, so this fails loudly and locally rather than behind an HTTP error.
 */
/**
 * Apps deliberately absent from both rosters.
 *
 * The copy on this page is lifted verbatim from `built_apps/0` in
 * BinaryBourbon/fountain, which is what renders built-with — so an app can
 * only be listed here once it is listed there, and writing a blurb locally
 * would just move the drift to the other comparison. Naming the exception is
 * the honest version: the check stays strict for the other twelve, and the
 * gap is a line of code somebody has to delete rather than a silence.
 *
 * salon: live at salon.demo.managoat.com since it shipped, never added to
 * built_apps/0. Remove this entry, and add salon to src/roster.ts, once the
 * fountain-side list has it.
 *
 * paddock: new, and not on built_apps/0 yet. Same deal — remove this entry and
 * add it to src/roster.ts together, once the fountain-side list has it.
 */
const UNLISTED_UPSTREAM = new Set(["salon", "paddock"]);

const REPO_APPS = new Set(
  readdirSync(new URL("../../", import.meta.url).pathname, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "fountain-demos" && !UNLISTED_UPSTREAM.has(e.name))
    .map((e) => e.name),
);
const rostered = new Set(DEMOS.map((d) => d.id));
const unlisted = [...REPO_APPS].filter((a) => !rostered.has(a)).sort();
const phantom = [...rostered].filter((a) => !REPO_APPS.has(a)).sort();
if (unlisted.length || phantom.length) {
  if (unlisted.length) console.error(`in apps/ but not in src/roster.ts:\n  ${unlisted.join("\n  ")}`);
  if (phantom.length) console.error(`in src/roster.ts but not in apps/:\n  ${phantom.join("\n  ")}`);
  process.exit(1);
}
console.log(`in step with apps/: ${rostered.size} apps`);

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
