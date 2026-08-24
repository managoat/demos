/**
 * Edit-as-you-type without a write per keystroke. A field renders from a
 * draft; the save follows the last keystroke by a pause, so typing a
 * paragraph is one PATCH and not a paragraph's worth. A record that changes
 * underneath an untouched field still wins — another member's edit arrives
 * over the stream — and anything still pending is flushed when the editor
 * closes or the page goes, so leaving mid-sentence does not lose it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type Debounced<T> = {
  /** Hold this value; save it once nothing else arrives for `delay`. */
  push(value: T): void;
  /** Save what is held now. */
  flush(): void;
  /** Drop what is held, unsaved. */
  cancel(): void;
  /** Is there an unsaved value? */
  pending(): boolean;
};

export function debounce<T>(save: (value: T) => void, delay: number): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held: { value: T } | null = null;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    stop();
    const h = held;
    held = null;
    if (h) save(h.value);
  };
  return {
    push(value) {
      held = { value };
      stop();
      timer = setTimeout(fire, delay);
    },
    flush: fire,
    cancel() {
      stop();
      held = null;
    },
    pending: () => held !== null,
  };
}

/**
 * `record` is what is saved, `draft` is what the field shows. Pass a stable
 * `record` (memoise an object on its fields) — it is the "someone else
 * changed it" signal.
 */
export function useDraft<T>(record: T, save: (value: T) => void, delay = 500) {
  const [draft, setDraft] = useState(record);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  const saver = useMemo(() => debounce<T>((value) => saveRef.current(value), delay), [delay]);

  // Follow the record while nothing of ours is in the air.
  useEffect(() => {
    if (!saver.pending()) setDraft(record);
  }, [record, saver]);

  // Unmount: save the sentence that was still being typed.
  useEffect(() => () => saver.flush(), [saver]);

  const edit = useCallback(
    (value: T) => {
      setDraft(value);
      saver.push(value);
    },
    [saver],
  );

  return { draft, edit, flush: saver.flush };
}
