/**
 * Images on a prompt: pasted, dropped or picked. Read to base64 in the
 * browser and checked against Fountain's rules (shared/images.ts) before
 * they go anywhere.
 */
import { useCallback, useMemo, useState, type ClipboardEvent, type DragEvent } from "react";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, type ImageInput } from "../../shared/images";

export interface Attachment {
  id: string;
  name: string;
  dataUrl: string;
  mediaType: ImageInput["media_type"];
  data: string;
}

export interface Attachments {
  items: Attachment[];
  add: (files: Iterable<File>) => void;
  remove: (id: string) => void;
  clear: () => void;
  paste: (e: ClipboardEvent) => void;
  drop: (e: DragEvent) => void;
  payload: ImageInput[] | null;
}

export function useAttachments(onProblem: (message: string) => void): Attachments {
  const [items, setItems] = useState<Attachment[]>([]);

  const add = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
          onProblem(`${file.name || "That file"} is not a PNG, JPEG, GIF or WebP.`);
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          onProblem(`${file.name || "That image"} is over 10 MB.`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result ?? "");
          const comma = dataUrl.indexOf(",");
          if (comma === -1) return;
          setItems((cur) => {
            if (cur.length >= MAX_IMAGES) {
              onProblem(`At most ${MAX_IMAGES} images on one message.`);
              return cur;
            }
            return [...cur, { id: crypto.randomUUID(), name: file.name || "image", dataUrl, mediaType: file.type as ImageInput["media_type"], data: dataUrl.slice(comma + 1) }];
          });
        };
        reader.readAsDataURL(file);
      }
    },
    [onProblem],
  );

  const remove = useCallback((id: string) => setItems((cur) => cur.filter((a) => a.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);

  const paste = useCallback(
    (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    },
    [add],
  );

  const drop = useCallback(
    (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    },
    [add],
  );

  const payload = useMemo(() => (items.length ? items.map((a) => ({ data: a.data, media_type: a.mediaType })) : null), [items]);

  return { items, add, remove, clear, paste, drop, payload };
}
