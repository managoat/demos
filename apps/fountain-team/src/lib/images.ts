/**
 * Composer image attachments (after OpenMausBot's composer-attachments):
 * paste, drop or pick image files, preview them as chips, and send them as
 * the API's `[{data: base64, media_type}]` beside the prompt. The allowlist
 * and size ceiling are the server's (FountainWeb.PromptImages), checked here
 * first so a bad file is refused before it is uploaded.
 */

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface OutgoingImage {
  /** base64 of the bytes, what the API takes */
  data: string;
  media_type: string;
  name: string;
  /** an object URL for the chip; revoke it when the chip goes away */
  previewUrl: string;
}

export function isImageMediaType(type: string): boolean {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/** Why a file cannot be attached, or null when it can. */
export function rejectImage(file: { type: string; size: number }): string | null {
  if (!isImageMediaType(file.type)) return `${file.type || "that file"} is not a supported image (png, jpeg, gif, webp)`;
  if (file.size > MAX_IMAGE_BYTES) return "images must be 10 MB or smaller";
  return null;
}

/** The image files in a paste or drop, in order; non-images are ignored. */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f && isImageMediaType(f.type)) out.push(f);
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (isImageMediaType(f.type)) out.push(f);
  return out;
}

export async function readImage(file: File): Promise<OutgoingImage> {
  const reason = rejectImage(file);
  if (reason) throw new Error(reason);
  const buf = await file.arrayBuffer();
  return {
    data: base64Of(new Uint8Array(buf)),
    media_type: file.type,
    name: file.name || "image",
    previewUrl: URL.createObjectURL(file),
  };
}

export function base64Of(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export function releaseImages(images: OutgoingImage[]): void {
  for (const img of images) {
    try {
      URL.revokeObjectURL(img.previewUrl);
    } catch {
      /* already gone */
    }
  }
}
