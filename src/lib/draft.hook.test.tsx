/**
 * The hook half of draft.ts. `debounce` under it is covered in draft.test.ts
 * against nothing but its own timer; these are the rules that need a render to
 * show, and that both callers (src/pages/WorkItem.tsx, src/pages/People.tsx)
 * lean on: a record that changes underneath an untouched field wins, one that
 * changes under a field being typed in does not, and what is still held is
 * saved on the way out.
 */
import { describe, expect, test } from "bun:test";
import { renderHook, step, wait } from "../../test/render";
import { useDraft } from "./draft";

type Settings = { name: string; notes: string };

// Short enough that a test waiting out a pause is not felt, long enough that
// the render and the assertions in between it comfortably fit.
const DELAY = 20;
const PAUSE = DELAY * 4;

type Props = { record: Settings; save: (value: Settings) => void };

const draftOf = (props: Props) => renderHook((p: Props) => useDraft(p.record, p.save, DELAY), props);

describe("useDraft", () => {
  test("a record that changes underneath an untouched field wins", async () => {
    const saved: Settings[] = [];
    const first = { name: "Ship it", notes: "" };
    const save = (v: Settings) => void saved.push(v);
    const h = await draftOf({ record: first, save });
    expect(h.current.draft).toBe(first);

    // Another member renames the project; nobody here is in the field.
    const renamed = { name: "Ship it on Friday", notes: "" };
    await h.set({ record: renamed, save });
    expect(h.current.draft).toBe(renamed);

    // Following someone else's edit is not an edit of ours to save back.
    await wait(PAUSE);
    expect(saved).toEqual([]);
    await h.unmount();
  });

  test("a record that changes under a field being typed in does not", async () => {
    const saved: Settings[] = [];
    const save = (v: Settings) => void saved.push(v);
    const h = await draftOf({ record: { name: "Ship it", notes: "" }, save });

    const typed = { name: "Ship it on Fri", notes: "" };
    await step(() => h.current.edit(typed));
    expect(h.current.draft).toBe(typed);

    // The same rename as above, but now the cursor is in the field: it must
    // not land on top of a half-typed sentence.
    await h.set({ record: { name: "Ship it on Friday", notes: "" }, save });
    expect(h.current.draft).toBe(typed);

    // And the pause saves what was typed here, not what arrived over the wire.
    await wait(PAUSE);
    expect(saved).toEqual([typed]);

    // Once nothing of ours is in the air, the record wins again.
    const later = { name: "Shipped", notes: "" };
    await h.set({ record: later, save });
    expect(h.current.draft).toBe(later);
    await h.unmount();
  });

  test("unmount flushes what was held", async () => {
    const saved: Settings[] = [];
    const halfTyped = { name: "Ship it on Fri", notes: "" };
    const h = await draftOf({ record: { name: "Ship it", notes: "" }, save: (v) => void saved.push(v) });

    await step(() => h.current.edit(halfTyped));
    expect(saved).toEqual([]);

    // Closing the editor, or leaving the page, mid-sentence.
    await h.unmount();
    expect(saved).toEqual([halfTyped]);
  });

  test("cancel, then unmount, saves nothing", async () => {
    // The settings page when the project is deleted under it: flushing on the
    // way out would save onto nothing.
    const saved: Settings[] = [];
    const h = await draftOf({ record: { name: "Ship it", notes: "" }, save: (v) => void saved.push(v) });

    await step(() => h.current.edit({ name: "Ship it on Fri", notes: "" }));
    await step(() => h.current.cancel());
    await h.unmount();
    await wait(PAUSE);
    expect(saved).toEqual([]);
  });

  test("the save that fires is the current one, not the one the edit was typed under", async () => {
    // Why the hook holds `save` in a ref: the callers pass a fresh closure
    // every render (it reads `item`, `updateItem`), and a debounced save that
    // ran the closure from four renders ago would write with stale context.
    const first: Settings[] = [];
    const second: Settings[] = [];
    const record = { name: "Ship it", notes: "" };
    const h = await draftOf({ record, save: (v) => void first.push(v) });

    const typed = { name: "Ship it on Fri", notes: "" };
    await step(() => h.current.edit(typed));
    await h.set({ record, save: (v) => void second.push(v) });

    await wait(PAUSE);
    expect(first).toEqual([]);
    expect(second).toEqual([typed]);
    await h.unmount();
  });
});
