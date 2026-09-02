# fountain-demos

**[demo.managoat.com](https://demo.managoat.com)** — the index of the apps
built on the [Managoat](https://managoat.com) API, sitting at the parent of
every host it lists.

Twelve apps, one per subdomain, each in its own repository under
[github.com/managoat](https://github.com/managoat). The page is a list of
links: no framework, no client-side JavaScript, no API calls. `src/build.ts`
renders `dist/index.html` from `src/roster.ts` and that is the whole pipeline.

## The drift problem, and what is done about it

This page existed before, fell three apps behind, and was retired to a
redirect because a hand-kept list next to a maintained one loses. The
maintained one is `built_apps/0` in
[BinaryBourbon/fountain](https://github.com/BinaryBourbon/fountain), which
renders [managoat.com/built-with](https://managoat.com/built-with).

It is back because the two pages do different jobs — this is a directory of
what is running, that is the product's case for it — but the failure mode did
not go away, so it is now watched rather than hoped about:

- `bun run drift` fetches built-with and exits non-zero if the two rosters name
  different apps. It runs in CI on every push **and on a daily schedule**, so
  an app added over there turns this repo red within a day even if nobody
  touches it.
- The copy in `src/roster.ts` is lifted from built-with verbatim, so the two
  descriptions agree on the day they are written.
- Host and source URL are not stored at all. Both are derived from `id`,
  because both are the id: `<id>.demo.managoat.com` and
  `github.com/managoat/<id>`. A field that can only hold one value cannot hold
  a wrong one.

## Adding an app

1. Add it to `built_apps/0` in BinaryBourbon/fountain — that list is the one
   with the long write-up and the tests.
2. Add the same `id`, glyph, name and blurb to `DEMOS` in `src/roster.ts`.

Step 2 is not optional, and CI will say so if you skip it.

## Develop

```bash
bun install
bun run build     # dist/index.html
bun test
bun run drift     # needs network; compares against the live built-with
```

## Deploy

`.github/workflows/build.yml` builds an nginx image on push to main, pushes
`ghcr.io/managoat/fountain-demos`, pins the sha into `k8s/deployment.yaml`, and
Flux in [jhgaylor/home-cloud](https://github.com/jhgaylor/home-cloud) rolls it
out. `demos.inevitable.fyi`, this index's first home, 308s here.

## License

MIT
