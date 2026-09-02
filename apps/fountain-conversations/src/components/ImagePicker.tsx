import { useRef, type ChangeEvent } from "react";
import type { ImageInput } from "../api/types";

const MAX_BYTES = 5 * 1024 * 1024;

/** Attach images to a prompt: read as base64, kept in memory until sent. */
export function ImagePicker({ images, onChange }: { images: ImageInput[]; onChange: (imgs: ImageInput[]) => void }) {
  const input = useRef<HTMLInputElement>(null);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const next = [...images];
    for (const f of files) {
      if (f.size > MAX_BYTES) continue;
      const data = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.readAsDataURL(f);
      });
      next.push({ data, media_type: f.type || "image/png" });
    }
    onChange(next);
    if (input.current) input.current.value = "";
  }

  return (
    <div className="image-picker">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => void pick(e)} />
      <button type="button" className="secondary small" onClick={() => input.current?.click()}>
        Attach image
      </button>
      {images.map((img, i) => (
        <span key={i} className="thumb">
          <img src={`data:${img.media_type};base64,${img.data}`} alt="" />
          <button type="button" className="thumb-x" aria-label="Remove image" onClick={() => onChange(images.filter((_, j) => j !== i))}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
