import { expect, test } from "bun:test";
import { imageMediaType } from "./image-type";

test("picker media types match the API and retain the empty-type PNG fallback", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"] as const) expect(imageMediaType(type)).toBe(type);
  expect(imageMediaType("")).toBe("image/png");
  expect(imageMediaType("image/svg+xml")).toBeNull();
});
