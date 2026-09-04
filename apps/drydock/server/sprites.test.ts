/**
 * The pieces of the Sprites client that can be proved without a machine.
 *
 * The socket itself cannot be tested here — it needs a sprite — so what is
 * asserted is everything around it that has been wrong before: the control
 * frames, the quoting that carries an arbitrary command, and the directory
 * resolution that keeps the panel pointed somewhere a diff exists.
 */
import { describe, expect, test } from "bun:test";
import { parseControl, resolveCwd, shq } from "./sprites";

describe("parseControl", () => {
  test("an exit frame carries its code", () => {
    expect(parseControl('{"type":"exit","exit_code":3}')).toEqual({ type: "exit", exitCode: 3 });
  });

  test("an exit with no code is exit 0 — Sprites omits it on success", () => {
    expect(parseControl('{"type":"exit"}')).toEqual({ type: "exit", exitCode: 0 });
  });

  test("a frame we do not act on is recognised rather than dropped", () => {
    // A future control type must not look like a parse failure, because the
    // caller treats null as "not JSON" and would log it.
    expect(parseControl('{"type":"port","port":3000}')).toEqual({ type: "port" });
  });

  test("anything that is not a control frame is null", () => {
    for (const raw of ["", "not json", "[]", "null", '{"exit_code":1}', '{"type":3}']) {
      expect(parseControl(raw)).toBeNull();
    }
  });
});

describe("shq", () => {
  test("wraps in single quotes, which is safe for arbitrary bytes", () => {
    expect(shq("/workspace/demos")).toBe("'/workspace/demos'");
    expect(shq("a b")).toBe("'a b'");
  });

  test("a single quote in the value does not end the quoting", () => {
    // The classic injection: `'; rm -rf /; '` has to come back out as data.
    expect(shq("it's")).toBe(String.raw`'it'\''s'`);
    expect(shq("'; echo pwned; '")).toContain(String.raw`'\''`);
  });
});

describe("resolveCwd", () => {
  const root = "/workspace/demos";

  test("no request means the root", () => {
    expect(resolveCwd(root, undefined)).toBe(root);
    expect(resolveCwd(root, "")).toBe(root);
  });

  test("a relative path lands under the root", () => {
    expect(resolveCwd(root, "apps/drydock")).toBe("/workspace/demos/apps/drydock");
    expect(resolveCwd(root, "./apps")).toBe("/workspace/demos/apps");
  });

  test("an absolute path inside the root is kept", () => {
    expect(resolveCwd(root, "/workspace/demos/apps")).toBe("/workspace/demos/apps");
  });

  test("walking out snaps back rather than stranding the panel", () => {
    expect(resolveCwd(root, "..")).toBe(root);
    expect(resolveCwd(root, "../../etc")).toBe(root);
    expect(resolveCwd(root, "/etc")).toBe(root);
    // A prefix match is not containment: /workspace/demos-2 is a different tree.
    expect(resolveCwd(root, "/workspace/demos-2")).toBe(root);
  });

  test("interior dot-dots resolve rather than being refused", () => {
    expect(resolveCwd(root, "apps/../shared")).toBe("/workspace/demos/shared");
  });

  test("trailing slashes and doubled separators normalise", () => {
    expect(resolveCwd(root, "apps//drydock/")).toBe("/workspace/demos/apps/drydock");
  });
});
