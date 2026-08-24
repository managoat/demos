import { describe, expect, test } from "bun:test";
import {
  decodedSize,
  downscaleTarget,
  DOWNSCALE_OVER_BYTES,
  formatBytes,
  imageProblem,
  imagesProblem,
  mayDownscale,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
} from "./images";

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

describe("mayDownscale", () => {
  test("what is worth decoding to measure, before anything is decoded", () => {
    expect(mayDownscale("image/png", DOWNSCALE_OVER_BYTES + 1)).toBe(true);
    expect(mayDownscale("image/jpeg", DOWNSCALE_OVER_BYTES + 1)).toBe(true);
    expect(mayDownscale("image/webp", DOWNSCALE_OVER_BYTES + 1)).toBe(true);
    // A GIF is never a candidate, at any size: one frame is not the picture.
    expect(mayDownscale("image/gif", 9 * 1024 * 1024)).toBe(false);
    expect(mayDownscale("image/png", DOWNSCALE_OVER_BYTES)).toBe(false);
  });
});

describe("downscaleTarget", () => {
  const big = DOWNSCALE_OVER_BYTES + 1;

  test("a 4K screenshot comes down to the long edge, keeping its shape", () => {
    expect(downscaleTarget("image/png", big, 3840, 2160)).toEqual({ width: 2000, height: 1125 });
    // Portrait: the long edge is the height, and the width follows it.
    expect(downscaleTarget("image/png", big, 2160, 3840)).toEqual({ width: 1125, height: 2000 });
    expect(downscaleTarget("image/jpeg", big, 6000, 6000)).toEqual({ width: 2000, height: 2000 });
    // A panorama keeps at least a pixel of its short side rather than none.
    expect(downscaleTarget("image/webp", big, 40_000, 3)).toEqual({ width: 2000, height: 1 });
  });

  test("small enough on the wire is left alone, however many pixels it is", () => {
    expect(downscaleTarget("image/png", DOWNSCALE_OVER_BYTES, 3840, 2160)).toBeNull();
    expect(downscaleTarget("image/png", 40_000, 8000, 8000)).toBeNull();
  });

  test("a big file that is not big in pixels is already as small as it gets", () => {
    expect(downscaleTarget("image/png", big, MAX_IMAGE_EDGE, MAX_IMAGE_EDGE)).toBeNull();
    expect(downscaleTarget("image/png", big, 1024, 768)).toBeNull();
  });

  test("never a GIF: a canvas keeps one frame, and would drop the animation", () => {
    expect(downscaleTarget("image/gif", big, 3840, 2160)).toBeNull();
    // Nor anything the composer would have refused before reaching here.
    expect(downscaleTarget("image/bmp", big, 3840, 2160)).toBeNull();
    expect(downscaleTarget("", big, 3840, 2160)).toBeNull();
  });

  test("dimensions a decoder could not give are not a size to draw at", () => {
    expect(downscaleTarget("image/png", big, 0, 2160)).toBeNull();
    expect(downscaleTarget("image/png", big, 3840, Number.NaN)).toBeNull();
    expect(downscaleTarget("image/png", big, Number.POSITIVE_INFINITY, 10)).toBeNull();
  });

  test("it shrinks what is admitted; it does not admit what is refused", () => {
    // Over Fountain's ceiling the composer refuses by name (src/lib/images.ts),
    // and this must never be the reason a 12 MB file gets sent anyway.
    const over = downscaleTarget("image/png", MAX_IMAGE_BYTES + 1, 3840, 2160);
    expect(over).toEqual({ width: 2000, height: 1125 });
    expect(imageProblem({ data: png(MAX_IMAGE_BYTES + 1), media_type: "image/png" })).toContain("10.0 MB");
  });
});

test("formatBytes reads like a file manager", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(MAX_IMAGE_BYTES)).toBe("10.0 MB");
});
