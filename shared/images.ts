/**
 * Fountain's rules for images on a prompt, applied before the request goes
 * out so a bad file is refused by name rather than as a failed POST.
 */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 10;

export interface ImageInput {
  data: string;
  media_type: (typeof IMAGE_TYPES)[number];
}

/** Why this `images` value would be refused, or null when it is fine. */
export function imagesProblem(images: unknown): string | null {
  if (images == null) return null;
  if (!Array.isArray(images)) return "images must be a list.";
  if (images.length > MAX_IMAGES) return `At most ${MAX_IMAGES} images on one prompt.`;
  for (const img of images) {
    if (!img || typeof img !== "object") return "Each image needs data and media_type.";
    const { data, media_type } = img as Record<string, unknown>;
    if (typeof data !== "string" || !data) return "Each image needs base64 data.";
    if (!(IMAGE_TYPES as readonly string[]).includes(String(media_type))) return `Images must be one of ${IMAGE_TYPES.join(", ")}.`;
    // base64 is 4/3 of the bytes.
    if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) return "An image must be 10 MB or smaller.";
  }
  return null;
}
