import { expect, test } from "bun:test";
import { href, parseRoute } from "./router";

test("routes", () => {
  expect(parseRoute("")).toEqual({ page: "projects" });
  expect(parseRoute("#/")).toEqual({ page: "projects" });
  expect(parseRoute("#/p/abc/team")).toEqual({ page: "team", projectId: "abc" });
  expect(parseRoute("#/team")).toEqual({ page: "projects" });
  expect(parseRoute("#/p/abc")).toEqual({ page: "project", projectId: "abc" });
  expect(parseRoute("#/p/abc/w/def")).toEqual({ page: "item", projectId: "abc", itemId: "def", conversationId: null });
  expect(parseRoute(href.conversation("abc", "def", "c1"))).toEqual({ page: "item", projectId: "abc", itemId: "def", conversationId: "c1" });
});
