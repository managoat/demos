/**
 * Signing in, on a page of its own.
 *
 * It used to be the last section of the landing page, which made the pitch and
 * the form one scroll: somebody who already knew what Rounds was had to read
 * past all of it, and the hero — the one part everybody reads — had nothing to
 * click. Now the hero points here, and here is only the form.
 *
 * The route is `#/sign-in` rather than a path, so a reload cannot 404 against
 * a static host, and the `#/` prefix keeps it out of the way of the landing
 * page's own anchors (`#what`, `#tiers`).
 */
import { Connect } from "./Connect";
import type { Settings } from "../lib/settings";

/** The hash that means "show the sign-in page". */
export const SIGN_IN_ROUTE = "#/sign-in";

/** Is this hash the sign-in route? `#what` and friends are anchors, not routes. */
export function isSignInRoute(hash: string): boolean {
  return hash.replace(/\/+$/, "") === SIGN_IN_ROUTE;
}

export function SignIn(props: { error: string | null; onPaste: (s: Settings) => void }) {
  return (
    <div className="setup">
      <div className="signin">
        <a className="wordmark" href="#">
          Rounds<span>.</span>
        </a>
        <Connect error={props.error} onPaste={props.onPaste} />
        <a className="linkish" href="#">
          ← what Rounds does
        </a>
      </div>
    </div>
  );
}
