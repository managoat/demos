/**
 * Where you say something to the machine.
 *
 * The one rule it enforces is the thread's: a machine that is still being
 * built cannot be talked to, and a turn that is running is stopped rather than
 * interrupted with a second question. Both of those are states the composer
 * *says* rather than states it silently drops keystrokes in.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ApiError, interrupt } from "../api/client";
import type { Thread } from "../../shared/api";

export interface ComposerProps {
  thread: Thread;
  /** The model this project's machines run. */
  model: string;
  /** The chips above the box, from the thread's header. */
  starters: { label: string; prompt: string }[];
  /** Whether to show them: they are an invitation, not a toolbar. */
  showStarters: boolean;
  /** Sends the prompt. Rejects with the server's own words. */
  onSend: (prompt: string) => Promise<void>;
}

/** The textarea grows to here and then scrolls. Roughly ten lines. */
const MAX_HEIGHT = 208;
/** Remembered so the "not built yet" note about `@` and `/` is said once, not every time. */
const HINT_KEY = "drydock.composer-hint";

export function Composer({ thread, model, starters, showStarters, onSend }: ComposerProps) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);

  const building = thread.status === "building";
  const closed = thread.status === "closed";
  const running = thread.status === "running";
  const failed = thread.status === "failed";
  const disabled = building || closed || failed;

  // ⌘L from anywhere in the app, which is the shortcut the placeholder claims.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        box.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const change = useCallback((value: string) => {
    setText(value);
    // `@` and `/` are in the placeholder because they are what people expect;
    // neither is built. Saying so the first time somebody reaches for one is
    // cheaper than letting them find out by typing a filename that goes
    // nowhere.
    if (/[@/]/.test(value) && !seenHint()) setHint(true);
  }, []);

  const dismissHint = useCallback(() => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      // A browser that will not store it will simply be told again.
    }
  }, []);

  const send = useCallback(async () => {
    const prompt = text.trim();
    if (!prompt || busy || disabled || running) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(prompt);
      setText("");
    } catch (err) {
      // The text stays in the box. Losing what somebody wrote is worse than
      // showing them why it did not go.
      setError(err instanceof ApiError ? err.message : "That could not be sent.");
    } finally {
      setBusy(false);
    }
  }, [text, busy, disabled, running, onSend]);

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await interrupt(thread.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That turn could not be stopped.");
    } finally {
      setBusy(false);
    }
  }, [thread.id]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const pick = (prompt: string) => {
    setText(prompt);
    box.current?.focus();
  };

  return (
    <div className="dd-th-composer">
      {showStarters && starters.length > 0 && !disabled && (
        <div className="dd-th-starters">
          {starters.map((s) => (
            <button key={s.label} className="dd-th-starter" onClick={() => pick(s.prompt)} title={s.prompt}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {hint && (
        <div className="dd-th-hint">
          <span>
            <code>@</code> and <code>/</code> are not wired up yet &mdash; type the path or the command in the prompt
            instead.
          </span>
          <button className="ghost" onClick={dismissHint}>
            Got it
          </button>
        </div>
      )}

      {error && <p className="fine error dd-th-composer-error">{error}</p>}

      <div className={`dd-th-box${disabled ? " dd-th-box-off" : ""}`}>
        <div className="dd-th-box-top">
          <textarea
            ref={box}
            className="dd-th-input"
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={
              building
                ? "This machine is still being built."
                : failed
                  ? "This thread has no machine to talk to."
                  : closed
                    ? "This thread is closed."
                    : "Ask to make changes, @mention files, run /commands"
            }
            onChange={(e) => change(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="dd-th-shortcut faint">&#8984;L to focus</span>
        </div>

        <div className="dd-th-box-foot">
          <span className="chip mono" title="The model every machine in this project runs">
            {model}
          </span>
          {building && <span className="fine">Talk to it once the first turn has finished.</span>}
          {failed && <span className="fine">Its machine never finished being built. Open a new thread to carry on.</span>}
          {closed && <span className="fine">Closed threads are readable, not writable.</span>}
          <span className="spacer" />
          {running ? (
            <button className="dd-th-send" onClick={() => void stop()} disabled={busy} title="Stop this turn">
              <StopIcon />
              Stop
            </button>
          ) : (
            <button
              className="dd-th-send primary"
              onClick={() => void send()}
              disabled={disabled || busy || text.trim().length === 0}
              title="Send (Enter)"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function seenHint(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 12.8V3.6M4.2 7.2 8 3.4l3.8 3.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.4" />
    </svg>
  );
}
