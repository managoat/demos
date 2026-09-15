import type { ImageInput } from "../api/types";

/** Match the picker accept list and the API; preserve the empty-MIME PNG fallback. */
export function imageMediaType(type: string): ImageInput["media_type"] | null {
  switch (type) {
    case "": return "image/png";
    case "image/png": case "image/jpeg": case "image/gif": case "image/webp": return type;
    default: return null;
  }
}
