/**
 * Files from a paste or a drop, turned into the `ImageInput` a prompt takes.
 *
 * The checks are the API's (`shared/images.ts`), applied here so a 12 MB
 * screenshot says so in the composer instead of coming back as a 422 with
 * the prompt already typed.
 */
import { formatBytes, isImageMediaType, MAX_IMAGE_BYTES, type ImageInput } from "../../shared/images";

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
  const data = toBase64(new Uint8Array(await file.arrayBuffer()));
  return { name, bytes: file.size, image: { data, media_type: file.type } };
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
