/**
 * Mounting, for tests. Everything here is wrapped in React's `act`, so by the
 * time a call returns React has rendered, run the effects it scheduled, and
 * settled — which is the whole reason to have a document (test/preload.ts) in
 * the first place: `renderToStaticMarkup` never gets that far.
 *
 * This is deliberately small. @testing-library/react would do the same and
 * more, but react-dom/client in a happy-dom global is already enough, and this
 * repo's dependency list is react, react-dom and the SDK.
 */
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/**
 * Do something to a mounted tree — dispatch an event, call what a hook
 * returned — and let React catch up before the next assertion.
 */
export const step = (body: () => void | Promise<void>) => act(body);

/**
 * Let real time pass. The debounce behind a draft, a fetch that resolves, an
 * abort: these run on real timers, so the test waits on one too.
 */
export const wait = (ms: number) => act(async () => Bun.sleep(ms));

export type Mounted = {
  /** The element the tree is rendered into, attached to `document.body`. */
  readonly container: HTMLElement;
  /** Render again — new props from above, as a parent re-rendering would. */
  render(node: ReactNode): Promise<void>;
  unmount(): Promise<void>;
};

export async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: ReactNode) => {
    await act(async () => root.render(next));
  };
  await render(node);
  return {
    container,
    render,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export type Rendered<P, T> = {
  /** What the hook returned on its most recent render. */
  readonly current: T;
  /** Render it again with these props — the record changing underneath it. */
  set(props: P): Promise<void>;
  /** Unmount, which runs the hook's cleanups. */
  unmount(): Promise<void>;
};

/**
 * Run a hook on its own, in a component that renders nothing. `props` is one
 * value rather than an argument list so that `set` reads as "and now the world
 * looks like this".
 */
export async function renderHook<P, T>(use: (props: P) => T, props: P): Promise<Rendered<P, T>> {
  let last: { value: T } | null = null;
  const Probe = ({ props: p }: { props: P }) => {
    last = { value: use(p) };
    return null;
  };
  const mounted = await mount(<Probe props={props} />);
  return {
    get current() {
      if (!last) throw new Error("the hook has not rendered");
      return last.value;
    },
    set: (next: P) => mounted.render(<Probe props={next} />),
    unmount: () => mounted.unmount(),
  };
}
