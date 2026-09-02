import { afterEach, describe, expect, test } from "bun:test";
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

/**
 * The canvas half of `readImage` is the browser's, and there is no browser
 * here: these stand a fake one up to hold its guards still. What the pixels
 * come out looking like is a thing only a real browser can answer, and the
 * pull request says what a real 4K screenshot did.
 */
describe("downscaling before the encode", () => {
  const env = globalThis as Record<string, unknown>;
  const saved = { createImageBitmap: env.createImageBitmap, OffscreenCanvas: env.OffscreenCanvas };
  let decodes = 0;
  let drawn: { width: number; height: number } | null = null;

  /** A decoder of the given size, and an encoder that answers whatever `out` says. */
  const fakeCanvas = (bitmap: { width: number; height: number }, out: (type: string) => Blob | Promise<Blob>) => {
    decodes = 0;
    drawn = null;
    env.createImageBitmap = async () => {
      decodes++;
      return { ...bitmap, close() {} };
    };
    env.OffscreenCanvas = class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: (_b: unknown, _x: number, _y: number, width: number, height: number) => void (drawn = { width, height }) };
      }
      convertToBlob({ type }: { type: string }) {
        return Promise.resolve(out(type));
      }
    };
  };

  const blob = (type: string, bytes: number) => new Blob([new Uint8Array(bytes).fill(3)], { type });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete env[k] : (env[k] = v);
  });

  test("a 4K screenshot is redrawn to 2000px and sent as the smaller bytes", async () => {
    fakeCanvas({ width: 3840, height: 2160 }, (type) => blob(type, 400_000));
    const read = await readImage(file("4k.png", "image/png", 3_000_000));
    expect(drawn).toEqual({ width: 2000, height: 1125 });
    expect(read.bytes).toBe(400_000); // what is on the wire, not what was picked
    expect(Buffer.from(read.image.data, "base64")).toHaveLength(400_000);
    expect(read.image.media_type).toBe("image/png");
  });

  test("if the re-encode is not smaller, the original goes as it was", async () => {
    fakeCanvas({ width: 3840, height: 2160 }, (type) => blob(type, 3_000_001));
    expect((await readImage(file("4k.png", "image/png", 3_000_000))).bytes).toBe(3_000_000);
  });

  test("an encoder that answered in another format is not what we would be sending", async () => {
    // convertToBlob falls back to PNG for a type it cannot write, and the
    // media_type on the payload is the file's: that pair would be a lie.
    fakeCanvas({ width: 4000, height: 4000 }, () => blob("image/png", 10));
    expect((await readImage(file("shot.webp", "image/webp", 3_000_000))).bytes).toBe(3_000_000);
  });

  test("a file the decoder will not take is still sent", async () => {
    fakeCanvas({ width: 3840, height: 2160 }, (type) => blob(type, 10));
    env.createImageBitmap = async () => {
      throw new Error("The source image could not be decoded.");
    };
    expect((await readImage(file("odd.png", "image/png", 3_000_000))).bytes).toBe(3_000_000);
  });

  test("an animated GIF is never decoded, let alone flattened to one frame", async () => {
    fakeCanvas({ width: 3840, height: 2160 }, (type) => blob(type, 10));
    expect((await readImage(file("loop.gif", "image/gif", 3_000_000))).bytes).toBe(3_000_000);
    expect(decodes).toBe(0);
  });

  test("without a canvas at all — an old browser, this test runner — nothing changes", async () => {
    delete env.createImageBitmap;
    delete env.OffscreenCanvas;
    const read = await readImage(file("4k.png", "image/png", 3_000_000));
    expect(read.bytes).toBe(3_000_000);
    expect(Buffer.from(read.image.data, "base64")).toHaveLength(3_000_000);
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
