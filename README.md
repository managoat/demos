# fountain-demos (retired)

**[demos.inevitable.fyi](https://demos.inevitable.fyi) now redirects to
[managoat.com/built-with](https://managoat.com/built-with).**

This repository served a hand-written landing page indexing the applications
built on the [Fountain](https://github.com/BinaryBourbon/fountain) API. That
index now lives on the product site itself, where the roster is a list in code
(`FountainWeb.MarketingHTML.built_apps/0`) with tests that require every entry
to name a reachable URL and a real repository.

Keeping a second copy by hand did not work: this page ended three apps behind
(Workbench, Reflex and Conversations were missing) and still told readers to
point their client at `fountain.inevitable.fyi`, an address the server moved
off of. One list, checked by a suite, beats two lists that disagree.

## What is left here

Only the Kubernetes manifests in `k8s/`, and they no longer run anything. The
host keeps its DNS record and its certificate; a Traefik middleware answers
every path with a 308 to the new page. There is no Deployment, no Service, no
image and no build workflow.

The page's source is in this repository's history, at the commit before this
one.

## Adding an app to the index

Edit `built_apps/0` in
[BinaryBourbon/fountain](https://github.com/BinaryBourbon/fountain)
(`apps/fountain/lib/fountain_web/controllers/marketing_html.ex`). Nothing here
needs to change, ever again.

## License

MIT
