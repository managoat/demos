/**
 * Files from a paste or a drop, turned into the `ImageInput` a prompt takes.
 *
 * The checks are the API's (`shared/images.ts`), applied here so a 12 MB
 * screenshot says so in the composer instead of coming back as a 422 with
 * the prompt already typed.
 */
import { downscaleTarget, formatBytes, isImageMediaType, mayDownscale, MAX_IMAGE_BYTES, type ImageInput } from "../../shared/images";

/** One attached image, as the composer holds it: the payload plus what to show. */
export interface Attachment {
  id: string;
  name: string;
  bytes: number;
  image: ImageInput;
}

/** Anything the browser calls an image; the media type itself is judged in `readImage`. */
export function imageFiles(list: FileList | File[] | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
}

/** Read one file, or throw with what is wrong with it. */
export async function readImage(file: File): Promise<Omit<Attachment, "id">> {
  const name = file.name || "pasted image";
  if (!isImageMediaType(file.type)) {
    throw new Error(`${name} is ${file.type || "not an image"} — attach a PNG, JPEG, GIF or WebP.`);
  }
  // `file.size` is the decoded size, which is what the API measures.
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_IMAGE_BYTES)} an image.`);
  }
  // Only after it is admitted: a big screenshot is sent smaller, an oversized
  // one is still refused above rather than resized into the limit.
  const blob = await downscale(file);
  const data = toBase64(new Uint8Array(await blob.arrayBuffer()));
  // `bytes` is what goes on the wire, not what was picked.
  return { name, bytes: blob.size, image: { data, media_type: file.type } };
}

/**
 * Re-encode an oversized screenshot at the size `downscaleTarget` allows, so
 * 10 MB of PNG is not 13.3 MB of base64 through the proxy.
 *
 * Everything here is the browser's: `createImageBitmap` decodes, a canvas
 * draws it smaller, `convertToBlob` encodes it back at the *same* media type.
 * Where any of that is missing (a test runner, an old browser) or fails (a
 * file the decoder will not take), the answer is the file as it was picked —
 * shrinking is an optimisation, never a reason not to send.
 */
async function downscale(file: File): Promise<Blob> {
  const env = globalThis as {
    createImageBitmap?: (b: Blob) => Promise<ImageBitmap>;
    OffscreenCanvas?: typeof OffscreenCanvas;
  };
  // Cheap first: a small paste and an animated GIF never reach the decoder.
  if (!mayDownscale(file.type, file.size)) return file;
  if (typeof env.createImageBitmap !== "function" || typeof env.OffscreenCanvas !== "function") return file;
  try {
    const bitmap = await env.createImageBitmap(file);
    try {
      const target = downscaleTarget(file.type, file.size, bitmap.width, bitmap.height);
      if (!target) return file;
      const canvas = new env.OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      // JPEG and WebP are lossy anyway and encode at 1.0 by default in some
      // browsers, which can come back *bigger*; PNG ignores quality.
      const shrunk = await canvas.convertToBlob({ type: file.type, quality: 0.92 });
      // Two ways this is not a win: the encoder fell back to another format
      // (`convertToBlob` answers PNG for a type it cannot write, and the media
      // type we send is the file's), or re-encoding simply grew it.
      if (shrunk.type !== file.type || shrunk.size >= file.size) return file;
      return shrunk;
    } finally {
      bitmap.close?.();
    }
  } catch {
    return file;
  }
}

/** A thumbnail source: the bytes we already hold, so nothing is fetched back. */
export function imageSrc(image: ImageInput): string {
  return `data:${image.media_type};base64,${image.data}`;
}

/** Chunked, because `String.fromCharCode(...bytes)` blows the argument limit on a real screenshot. */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
