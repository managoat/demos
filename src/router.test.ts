import { describe, expect, test } from "bun:test";
import { parseRoute, paths } from "./router";

const ID = "0f2c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const OTHER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("parseRoute", () => {
  test("the new form, plain and with a parent or a sandbox", () => {
    expect(parseRoute("#/new")).toEqual({ page: "new" });
    expect(parseRoute(paths.new({ parent: ID }))).toEqual({ page: "new", parentId: ID });
    expect(parseRoute(paths.new({ sandbox: ID }))).toEqual({ page: "new", sandboxId: ID });
    expect(parseRoute(paths.new({ parent: ID, sandbox: OTHER }))).toEqual({ page: "new", parentId: ID, sandboxId: OTHER });
  });

  test("a query value that is not an id is dropped, not trusted", () => {
    expect(parseRoute("#/new?sandbox=../admin")).toEqual({ page: "new" });
    expect(parseRoute("#/new?parent=x")).toEqual({ page: "new" });
  });

  test("the sandbox view", () => {
    expect(parseRoute(paths.sandbox(ID))).toEqual({ page: "sandbox", id: ID });
    expect(parseRoute("#/sandboxes/not-an-id")).toEqual({ page: "index" });
  });

  test("the routes that were already there", () => {
    expect(parseRoute("")).toEqual({ page: "index" });
    expect(parseRoute(paths.show(ID))).toEqual({ page: "show", id: ID });
    expect(parseRoute(paths.logs(ID))).toEqual({ page: "logs", id: ID });
    expect(parseRoute(paths.agent("new"))).toEqual({ page: "agent", id: "new" });
    expect(parseRoute(paths.vault(ID))).toEqual({ page: "vault", id: ID });
  });
});
