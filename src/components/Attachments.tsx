/**
 * Images on a prompt: paste one into a composer, or drop it on one.
 *
 * Every place that sends a prompt — the thread's composer, and the two forms
 * that start a conversation — uses `useAttachments`, so a screenshot goes in
 * the same way wherever you are. The hook holds the images and hands back
 * the props to spread: `paste` on the textarea, `dropzone` on whatever
 * region should take a drop.
 */
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { ImageInput } from "../../shared/images";
import { imageFiles, imageSrc, readImage, type Attachment } from "../lib/images";
import { describeError } from "../lib/errors";

export interface Attachments {
  items: Attachment[];
  /** What to send, or undefined when there is nothing attached. */
  payload: ImageInput[] | undefined;
  add: (files: FileList | File[] | null) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  /** True while a drag is over the drop zone. */
  dragging: boolean;
  paste: (e: ClipboardEvent) => void;
  dropzone: {
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}

export function useAttachments(onError: (message: string) => void): Attachments {
  const [items, setItems] = useState<Attachment[]>([]);
  // Drag events fire per element, so entering a child looks like leaving the
  // parent: count the enters instead of trusting one leave.
  const [depth, setDepth] = useState(0);
  const seq = useRef(0);
  const report = useRef(onError);
  report.current = onError;

  const add = useCallback(async (list: FileList | File[] | null) => {
    const files = [...(list ?? [])];
    if (files.length === 0) return;
    const images = imageFiles(files);
    if (images.length === 0) {
      report.current("Only images can be attached — PNG, JPEG, GIF or WebP.");
      return;
    }
    const read: Attachment[] = [];
    for (const file of images) {
      try {
        read.push({ id: `img-${++seq.current}`, ...(await readImage(file)) });
      } catch (err) {
        report.current(describeError(err));
      }
    }
    if (read.length) setItems((prev) => [...prev, ...read]);
  }, []);

  const remove = useCallback((id: string) => setItems((prev) => prev.filter((a) => a.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);

  const paste = useCallback(
    (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData?.files);
      if (files.length === 0) return; // ordinary text paste: leave it alone
      e.preventDefault();
      void add(files);
    },
    [add],
  );

  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

  const dropzone = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDepth((d) => d + 1);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // without this the browser opens the file instead
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      setDepth((d) => Math.max(0, d - 1));
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDepth(0);
      void add(e.dataTransfer.files);
    },
  };

  return { items, payload: items.length ? items.map((a) => a.image) : undefined, add, remove, clear, dragging: depth > 0, paste, dropzone };
}

/** The attached images, each with the button that takes it off again. */
export function AttachmentStrip({ items, onRemove }: { items: Attachment[]; onRemove: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="image-picker">
      {items.map((a) => (
        <span className="thumb" key={a.id}>
          <img src={imageSrc(a.image)} alt={a.name} title={a.name} />
          <button type="button" className="thumb-x" onClick={() => onRemove(a.id)} title={`Remove ${a.name}`} aria-label={`Remove ${a.name}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
