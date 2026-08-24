import { describe, expect, test } from "bun:test";
import { decodedSize, formatBytes, imageProblem, imagesProblem, MAX_IMAGE_BYTES } from "./images";

const png = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64");

describe("decodedSize", () => {
  test("the bytes behind the base64, padding and all", () => {
    expect(decodedSize(Buffer.from("hi").toString("base64"))).toBe(2); // "aGk=" — one pad
    expect(decodedSize(Buffer.from("hey").toString("base64"))).toBe(3); // no pad
    expect(decodedSize(Buffer.from("h").toString("base64"))).toBe(1); // two pads
    expect(decodedSize("")).toBe(0);
  });
  test("null for anything Base.decode64 would refuse: unpadded, wrapped, out of alphabet", () => {
    expect(decodedSize("aGk")).toBeNull();
    expect(decodedSize("aGk=\naGk=")).toBeNull();
    expect(decodedSize("data:image/png;base64,aGk=")).toBeNull();
    expect(decodedSize("a_-k")).toBeNull();
  });
});

describe("imageProblem", () => {
  test("a png of a few bytes is fine", () => {
    expect(imageProblem({ data: png(12), media_type: "image/png" })).toBeNull();
  });
  test("only the four media types Fountain stores", () => {
    expect(imageProblem({ data: png(12), media_type: "image/bmp" })).toContain("image/png");
    expect(imageProblem({ data: png(12), media_type: "application/pdf" })).toContain("image/webp");
    expect(imageProblem({ data: png(12) })).not.toBeNull();
  });
  test("the data has to be there, and be base64", () => {
    expect(imageProblem({ data: "", media_type: "image/png" })).toContain("base64 data");
    expect(imageProblem({ data: "not base64!", media_type: "image/png" })).toContain("base64");
    expect(imageProblem({ media_type: "image/png" })).toContain("base64 data");
    expect(imageProblem("aGk=")).toContain("object");
  });
  test("10 MB is the ceiling, measured on the decoded bytes", () => {
    expect(imageProblem({ data: png(MAX_IMAGE_BYTES), media_type: "image/jpeg" })).toBeNull();
    const over = imageProblem({ data: png(MAX_IMAGE_BYTES + 1), media_type: "image/jpeg" });
    expect(over).toContain("10.0 MB");
  });
});

describe("imagesProblem", () => {
  test("absent or empty is no problem", () => {
    expect(imagesProblem(undefined)).toBeNull();
    expect(imagesProblem(null)).toBeNull();
    expect(imagesProblem([])).toBeNull();
  });
  test("a list, and every one of them good", () => {
    expect(imagesProblem({ data: png(4), media_type: "image/png" })).toContain("list");
    expect(imagesProblem([{ data: png(4), media_type: "image/png" }, { data: png(4), media_type: "image/gif" }])).toBeNull();
    expect(imagesProblem([{ data: png(4), media_type: "image/png" }, { data: png(4), media_type: "image/tiff" }])).not.toBeNull();
  });
});

test("formatBytes reads like a file manager", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(MAX_IMAGE_BYTES)).toBe("10.0 MB");
});
