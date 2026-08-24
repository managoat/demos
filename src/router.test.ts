import { expect, test } from "bun:test";
import { href, parseRoute } from "./router";

test("routes", () => {
  expect(parseRoute("")).toEqual({ page: "projects" });
  expect(parseRoute("#/")).toEqual({ page: "projects" });
  expect(parseRoute("#/team")).toEqual({ page: "projects" });
  expect(parseRoute("#/p/abc")).toEqual({ page: "project", projectId: "abc" });
  expect(parseRoute("#/p/abc/team")).toEqual({ page: "team", projectId: "abc" });
  expect(parseRoute("#/p/abc/people")).toEqual({ page: "people", projectId: "abc" });
  expect(parseRoute("#/p/abc/w/def")).toEqual({ page: "item", projectId: "abc", itemId: "def" });
  expect(parseRoute(href.conversation("abc", "c1"))).toEqual({ page: "conversation", projectId: "abc", conversationId: "c1" });
  // The older item-scoped form still opens the conversation.
  expect(parseRoute("#/p/abc/w/def/c/c1")).toEqual({ page: "conversation", projectId: "abc", conversationId: "c1" });
});
