// PostHog, as a build-time opt-in: set VITE_POSTHOG_KEY (the public `phc_`
// project key) and the app captures session replays plus pageviews; leave it
// unset (local dev, forks) and every function here is a no-op. Imported
// dynamically to keep posthog-js out of the app's startup chunk.
//
// All inputs are masked in recordings — people paste API keys into this app.
//
// ── One project, and why that means identifying ──────────────────────────────
//
// This reports into the same PostHog project as Fountain itself, so a recording
// sits beside the server-side events for the same account and "watch what this
// person actually did" is one click from "this account's turn failed". Two
// projects cannot do that: PostHog has no cross-project person.
//
// Sharing the project means sharing its rules. Fountain's server capture drops
// events with no account attached so that person counts mean accounts, and this
// app has to keep that bargain or it would mint an anonymous person per viewer
// in a project the server keeps clean:
//
//   * `person_profiles: "identified_only"` — a viewer who is not signed in is
//     recorded, but is not a person.
//   * `identify(user.id)` with the *Fountain user id*, which is exactly the
//     distinct id the server captures under. That is what joins the two.
//
// The id is remembered locally so a returning viewer is identified on the first
// paint, rather than only after `me()` happens to be called — the app fetches
// it at sign-in and from Settings, and neither runs on an ordinary reload.

const PERSON_KEY = "fountain-team.person";

type PostHog = typeof import("posthog-js").default;

let loading: Promise<PostHog | null> | null = null;

function load(): Promise<PostHog | null> {
  if (loading) return loading;

  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) {
    loading = Promise.resolve(null);
    return loading;
  }

  loading = import("posthog-js").then(({ default: posthog }) => {
    posthog.init(key, {
      api_host: import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
      defaults: "2025-05-24",
      person_profiles: "identified_only",
      session_recording: { maskAllInputs: true },
    });
    // Matches the `surface` the Fountain server stamps on its own events
    // ("console" from the operator UI, "public" from the marketing pages), so
    // three apps in one project stay separable in every query.
    posthog.register({ surface: "team" });
    return posthog;
  });

  return loading;
}

/** Start capture, and re-identify a viewer this browser already knows. */
export function initAnalytics(): void {
  const known = rememberedPerson();

  void load().then((posthog) => {
    if (posthog && known) posthog.identify(known);
  });
}

/**
 * Name the signed-in account. Safe to call repeatedly and before posthog-js
 * has finished loading; PostHog ignores an identify that changes nothing.
 */
export function identifyPerson(userId: string): void {
  if (!userId) return;
  rememberPerson(userId);
  void load().then((posthog) => posthog?.identify(userId));
}

/**
 * Forget the viewer, on sign-out. Without this the next person to use the
 * browser inherits the last one's identity, and their recording is filed under
 * an account that is not theirs.
 */
export function forgetPerson(): void {
  forgetRemembered();
  void load().then((posthog) => posthog?.reset());
}

// ── The remembered id ────────────────────────────────────────────────────────
// Separated from the posthog-js calls, and storage is injectable, so the part
// with the rules can be tested without standing up an analytics library.

export function rememberedPerson(storage: Pick<Storage, "getItem"> = localStorage): string | null {
  try {
    const id = storage.getItem(PERSON_KEY);
    return id ? id : null;
  } catch {
    // A browser with storage blocked is anonymous, which is a valid state.
    return null;
  }
}

export function rememberPerson(userId: string, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(PERSON_KEY, userId);
  } catch {
    // Identity still holds for this page; it just will not survive a reload.
  }
}

export function forgetRemembered(storage: Pick<Storage, "removeItem"> = localStorage): void {
  try {
    storage.removeItem(PERSON_KEY);
  } catch {
    // Nothing stored, nothing to forget.
  }
}
