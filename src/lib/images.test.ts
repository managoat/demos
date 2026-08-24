import { describe, expect, test } from "bun:test";
import { MAX_IMAGE_BYTES } from "../../shared/images";
import { imageFiles, imageSrc, readImage } from "./images";

const file = (name: string, type: string, bytes: number) => new File([new Uint8Array(bytes).fill(7)], name, { type });

describe("readImage", () => {
  test("a screenshot comes back as the payload a prompt takes", async () => {
    const read = await readImage(file("shot.png", "image/png", 9));
    expect(read.name).toBe("shot.png");
    expect(read.bytes).toBe(9);
    expect(read.image.media_type).toBe("image/png");
    expect(Buffer.from(read.image.data, "base64")).toHaveLength(9);
    // Standard base64, so Fountain's Base.decode64 takes it: padded, one line.
    expect(read.image.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test("a pasted screenshot has no filename, and is still sendable", async () => {
    const read = await readImage(file("", "image/png", 4));
    expect(read.name).toBe("pasted image");
  });

  test("a format Fountain does not store is refused here, by name", async () => {
    await expect(readImage(file("old.bmp", "image/bmp", 4))).rejects.toThrow(/old\.bmp is image\/bmp/);
    await expect(readImage(file("notes.pdf", "application/pdf", 4))).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
  });

  test("over 10 MB is refused before the POST, with the size in the message", async () => {
    await expect(readImage(file("huge.png", "image/png", MAX_IMAGE_BYTES + 1))).rejects.toThrow(/huge\.png is 10\.0 MB — the limit is 10\.0 MB/);
    // Exactly at the limit is fine — the API's own boundary.
    expect((await readImage(file("edge.png", "image/png", MAX_IMAGE_BYTES))).bytes).toBe(MAX_IMAGE_BYTES);
  }, 20_000);

  test("bigger than a chunk of the base64 encoder, and still whole", async () => {
    const read = await readImage(file("wide.png", "image/png", 0x8000 * 2 + 5));
    expect(Buffer.from(read.image.data, "base64")).toHaveLength(0x8000 * 2 + 5);
  });
});

test("imageFiles keeps what the browser calls an image and drops the rest", () => {
  const kept = imageFiles([file("a.png", "image/png", 1), file("b.txt", "text/plain", 1), file("c.bmp", "image/bmp", 1)]);
  // image/bmp is for readImage to refuse by name; a text file is simply not for us.
  expect(kept.map((f) => f.name)).toEqual(["a.png", "c.bmp"]);
  expect(imageFiles(null)).toEqual([]);
});

test("a thumbnail reads the bytes we already hold", () => {
  expect(imageSrc({ data: "aGk=", media_type: "image/png" })).toBe("data:image/png;base64,aGk=");
});
