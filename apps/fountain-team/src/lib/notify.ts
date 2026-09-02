/**
 * Desktop notifications when a teammate you are not looking at replies
 * (after OpenMausBot's notify): opt-in per browser, quiet for muted
 * teammates and for the thread that is open in a focused window, one
 * notification per conversation at a time (the tag replaces the last).
 * Clicking one focuses the window and opens the thread.
 */

export type NotifyPermission = "unsupported" | "default" | "granted" | "denied";

export function notifyPermission(): NotifyPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifyPermission;
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission as NotifyPermission;
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return "denied";
  }
}

export interface NotifyDecision {
  enabled: boolean;
  permission: NotifyPermission;
  muted: boolean;
  /** the reply's thread is the one open on screen */
  isOpen: boolean;
  /** document.hidden — the tab is in the background */
  hidden: boolean;
}

/** Whether a finished turn should raise a notification. Pure, for tests. */
export function shouldNotify(d: NotifyDecision): boolean {
  if (!d.enabled || d.permission !== "granted" || d.muted) return false;
  return !d.isOpen || d.hidden;
}

/**
 * A teammate is blocked on a permission request (fountain#940).
 *
 * Distinct from a reply because it is not news, it is a question: nothing
 * moves until it is answered, and the server denies it if nobody does. Same
 * per-conversation tag, so it replaces rather than stacks.
 */
export function showRequestNotification(opts: {
  name: string;
  /** the tool being asked about, when the ask event named it */
  tool: string | null;
  conversationId: string;
  onClick: () => void;
}): void {
  showReplyNotification({
    name: opts.name,
    body: opts.tool ? `wants permission to run ${opts.tool}` : "wants your permission to continue",
    conversationId: opts.conversationId,
    onClick: opts.onClick,
  });
}

export function showReplyNotification(opts: {
  name: string;
  body: string;
  conversationId: string;
  onClick: () => void;
}): void {
  if (typeof Notification === "undefined") return;
  try {
    const n = new Notification(opts.name, { body: opts.body, tag: `fountain-team:${opts.conversationId}` });
    n.onclick = () => {
      window.focus();
      opts.onClick();
      n.close();
    };
  } catch {
    /* some browsers throw off the main thread; nothing to do */
  }
}
