import { beforeEach, describe, expect, test } from "bun:test";
import { isGithubCallback, isInstallCallback, takeInstallCallback } from "./ghoauth";

// The point of these: Rounds completes a *Fountain* OAuth callback on the same
// URL, and both arrive as ?code=…&state=…. If this ever claimed the wrong one,
// signing in to Fountain would silently break, so the disambiguation is pinned.

const STASH = "rounds.github.oauth";

function browserAt(search: string, stash?: { state: string }) {
  const store = new Map<string, string>();
  if (stash) store.set(STASH, JSON.stringify({ state: stash.state, redirectUri: "https://rounds.test/" }));
  const location = { search, origin: "https://rounds.test", pathname: "/", href: `https://rounds.test/${search}` };
  (globalThis as unknown as { window: unknown }).window = {
    location,
    history: {
      replaceState: (_s: unknown, _t: unknown, to: string) => {
        const url = new URL(to, "https://rounds.test");
        location.search = url.search;
        location.href = url.toString();
      },
    },
  };
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
}

describe("isGithubCallback", () => {
  beforeEach(() => browserAt(""));

  test("claims a callback whose state it stashed", () => {
    browserAt("?code=abc&state=s1", { state: "s1" });
    expect(isGithubCallback()).toBe(true);
  });

  test("leaves Fountain's callback alone — same shape, different state", () => {
    browserAt("?code=abc&state=fountain-state", { state: "github-state" });
    expect(isGithubCallback()).toBe(false);
  });

  test("leaves a callback alone when this flow never started", () => {
    browserAt("?code=abc&state=s1");
    expect(isGithubCallback()).toBe(false);
  });

  test("a plain page load is not a callback", () => {
    browserAt("", { state: "s1" });
    expect(isGithubCallback()).toBe(false);
  });

  test("claims its own denial so the error can be shown", () => {
    browserAt("?error=access_denied&state=s1", { state: "s1" });
    expect(isGithubCallback()).toBe(true);
  });

  test("a corrupt stash is not a match rather than a crash", () => {
    browserAt("?code=abc&state=s1");
    sessionStorage.setItem(STASH, "not json");
    expect(isGithubCallback()).toBe(false);
  });
});

// Installing the App is its own round-trip, and it used to be dropped on the
// floor: `installation_id` and `setup_action` were stripped and never read, so
// nothing ever noticed the App had been installed.
describe("the install callback", () => {
  beforeEach(() => browserAt(""));

  test("is recognized on the way back from GitHub", () => {
    browserAt("?installation_id=42&setup_action=install");
    expect(isInstallCallback()).toBe(true);
    expect(takeInstallCallback()).toEqual({ installationId: "42", action: "install" });
  });

  test("a plain page load is not one", () => {
    expect(isInstallCallback()).toBe(false);
    expect(takeInstallCallback()).toBeNull();
  });

  test("consuming it clears its own parameters and nothing else", () => {
    browserAt("?code=abc&state=s1&installation_id=42&setup_action=install", { state: "s1" });
    takeInstallCallback();
    // The sign-in half of the same redirect must survive — GitHub can land
    // both at once, and whichever ran first used to delete the other.
    expect(window.location.search).toBe("?code=abc&state=s1");
    expect(isGithubCallback()).toBe(true);
    expect(isInstallCallback()).toBe(false);
  });
});
