import { describe, expect, test } from "bun:test";
import { changedApps } from "./changed";

const KNOWN = ["arena", "mend", "salon"];

describe("changedApps", () => {
  test("an app's own source builds only that app", () => {
    expect(changedApps(["apps/arena/src/App.tsx"], KNOWN)).toEqual(["arena"]);
  });

  test("several apps at once", () => {
    expect(changedApps(["apps/arena/src/App.tsx", "apps/salon/server/index.ts"], KNOWN)).toEqual(["arena", "salon"]);
  });

  test("a shared library rebuilds everything, because every app embeds it", () => {
    expect(changedApps(["packages/fountain-app/src/sse.ts"], KNOWN)).toEqual(KNOWN);
  });

  test("the lockfile and the root toolchain rebuild everything", () => {
    expect(changedApps(["bun.lock"], KNOWN)).toEqual(KNOWN);
    expect(changedApps(["package.json"], KNOWN)).toEqual(KNOWN);
  });

  test("the pin step's own commit builds nothing — this is what stops the loop", () => {
    expect(changedApps(["apps/arena/k8s/deployment.yaml", "apps/mend/k8s/deployment.yaml"], KNOWN)).toEqual([]);
  });

  test("prose builds nothing", () => {
    expect(changedApps(["apps/arena/README.md", "README.md"], KNOWN)).toEqual([]);
  });

  test("prose alongside real work still builds the app", () => {
    expect(changedApps(["apps/arena/README.md", "apps/arena/src/App.tsx"], KNOWN)).toEqual(["arena"]);
  });

  test("an unknown directory under apps/ is ignored, not guessed at", () => {
    expect(changedApps(["apps/not-an-app/x.ts"], KNOWN)).toEqual([]);
  });

  test("k8s changes do not suppress a real change in the same push", () => {
    expect(changedApps(["apps/salon/k8s/service.yaml", "apps/salon/src/main.tsx"], KNOWN)).toEqual(["salon"]);
  });
});
