/**
 * An image attached to a prompt — Fountain's `ImageInput`, and the rules it
 * is judged by. Both sides read them: the browser refuses a file the API
 * would refuse (a real error before the upload, not a failed POST), and the
 * proxy refuses one anyway, since it forwards on the project owner's key.
 *
 * The rules are Fountain's own (`FountainWeb.PromptImages`): one of four
 * media types, standard base64 with padding — what `Base.decode64/1` takes —
 * and 10 MB of decoded bytes per image. There is no cap on how many.
 */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** What `POST /api/conversations` and `POST /api/conversations/:id/prompts` take in `images`. */
export interface ImageInput {
  /** Base64-encoded image bytes — no `data:` prefix, no newlines. */
  data: string;
  media_type: ImageMediaType;
}

/** Fountain's ceiling, per image, on the decoded bytes. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function isImageMediaType(v: unknown): v is ImageMediaType {
  return typeof v === "string" && (IMAGE_MEDIA_TYPES as readonly string[]).includes(v);
}

/**
 * Under this, base64 is not what is wrong with the request: a re-encode costs
 * a decode and a draw for a saving nobody notices.
 */
export const DOWNSCALE_OVER_BYTES = 2 * 1024 * 1024;

/** What a screenshot is worth on its long edge. A 4K one says no more than this. */
export const MAX_IMAGE_EDGE = 2000;

/**
 * Whether an image is worth decoding to find out — the half of the policy
 * that needs no dimensions, so a pasted icon and an animated GIF never reach
 * a canvas at all.
 */
export function mayDownscale(mediaType: string, bytes: number): boolean {
  // Not GIF: a canvas keeps one frame, so re-encoding an animated one would
  // silently throw the animation away.
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") return false;
  return bytes > DOWNSCALE_OVER_BYTES;
}

/**
 * The size to re-encode an attached image at before sending it, or null to
 * send the file as it was picked — the policy behind `readImage`'s canvas,
 * kept here as a pure function so it is testable without one.
 *
 * Base64 is 4/3, so a 10 MB screenshot is 13.3 MB of JSON body, through the
 * browser, through the proxy, and on to Fountain. A UI screenshot at
 * 3840×2160 carries no more information at that size than at 2000px.
 *
 * This never admits a file `imageProblem` would refuse: it shrinks what is
 * already under `MAX_IMAGE_BYTES`, and a 12 MB image is still refused by name
 * in the composer rather than silently resized into the limit.
 */
export function downscaleTarget(
  mediaType: string,
  bytes: number,
  width: number,
  height: number,
): { width: number; height: number } | null {
  if (!mayDownscale(mediaType, bytes)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const long = Math.max(width, height);
  if (long <= MAX_IMAGE_EDGE) return null;
  const scale = MAX_IMAGE_EDGE / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * How many bytes a base64 string decodes to, or null if it is not the base64
 * Fountain decodes — padded, no whitespace, nothing outside the alphabet.
 */
export function decodedSize(b64: string): number | null {
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

/** Why this is not an image Fountain would take, or null if it is one. */
export function imageProblem(img: unknown): string | null {
  if (typeof img !== "object" || img === null) return "Each image must be an object.";
  const { data, media_type } = img as { data?: unknown; media_type?: unknown };
  if (!isImageMediaType(media_type)) return `An image must be one of ${IMAGE_MEDIA_TYPES.join(", ")}.`;
  if (typeof data !== "string" || !data) return "An image must carry base64 data.";
  const bytes = decodedSize(data);
  if (bytes === null) return "Image data must be base64-encoded.";
  if (bytes > MAX_IMAGE_BYTES) return `An image is ${formatBytes(bytes)} — the limit is ${formatBytes(MAX_IMAGE_BYTES)}.`;
  return null;
}

/** The same for a whole `images` list, which may be absent. */
export function imagesProblem(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return "images must be a list.";
  for (const img of v) {
    const problem = imageProblem(img);
    if (problem) return problem;
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
