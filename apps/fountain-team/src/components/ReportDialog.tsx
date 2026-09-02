import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import { imageFilesFrom, readImage, releaseImages, type OutgoingImage } from "../lib/images";
import { REPORT_CATEGORIES, type ReportContext } from "../lib/report";

/**
 * "Report a problem": a category, what happened, an optional screenshot
 * (paste or attach), and the context the app already has — shown, so
 * nothing is sent that the user cannot see. POST /api/support/reports;
 * the operator gets it as an issue and/or mail.
 */
export function ReportDialog({
  client,
  context,
  about,
  onClose,
  toast,
}: {
  client: FountainClient;
  context: ReportContext;
  /** the teammate the report is about, if any — preselects "stuck" and names them */
  about: string | null;
  onClose: () => void;
  toast: (t: string, k?: "info" | "error") => void;
}) {
  const [category, setCategory] = useState(about ? "stuck" : "bug");
  const [message, setMessage] = useState("");
  const [shot, setShot] = useState<OutgoingImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    textRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(
    () => () => {
      if (shot) releaseImages([shot]);
    },
    [shot],
  );

  const attach = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    try {
      const img = await readImage(f);
      setShot((prev) => {
        if (prev) releaseImages([prev]);
        return img;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFrom(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      void attach(files);
    }
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.createSupportReport({
        category,
        message: message.trim(),
        context: context as unknown as Record<string, unknown>,
        client: context.app,
        screenshot: shot ? { data: shot.data, media_type: shot.media_type } : null,
      });
      toast(`Sent — thanks. Report ${r.id.slice(0, 8)}.`);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-root">
      <div className="backdrop" onClick={onClose} />
      <form className="modal add report" onSubmit={submit} role="dialog" aria-label="Report a problem">
        <header>
          <h2>Report a problem</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <p className="muted small">
          Goes to the people who run this Fountain, with what this app knows about{" "}
          {about ? (
            <>
              <b>{about}</b>'s thread
            </>
          ) : (
            "the current page"
          )}{" "}
          (shown below). Not for things you'd tell a teammate — this isn't an agent.
        </p>
        <label>
          What kind of thing
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {REPORT_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.hint ? ` — ${c.hint}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          What happened
          <textarea
            ref={textRef}
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onPaste={onPaste}
            placeholder={about ? `e.g. ${about} has said "starting computer" for ten minutes; sending a message does nothing.` : "What you did, what you expected, what you got."}
            maxLength={20_000}
          />
          <span className="hint">Paste a screenshot straight into this box, or attach one.</span>
        </label>
        <div className="row">
          <button type="button" className="secondary small" onClick={() => fileRef.current?.click()}>
            {shot ? "Replace screenshot" : "Attach a screenshot"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              void attach(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {shot && (
            <div className="attachment">
              <img src={shot.previewUrl} alt="" />
              <button type="button" className="remove" onClick={() => setShot(null)} aria-label="Remove screenshot">
                ×
              </button>
            </div>
          )}
        </div>
        <details className="report-context" open={showContext} onToggle={(e) => setShowContext((e.target as HTMLDetailsElement).open)}>
          <summary className="small muted">What's attached: {summarize(context)}</summary>
          <pre>{JSON.stringify(context, null, 2)}</pre>
        </details>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !message.trim()}>
            {busy ? "Sending…" : "Send report"}
          </button>
        </div>
      </form>
    </div>
  );
}

function summarize(ctx: ReportContext): string {
  const parts = [ctx.app, ctx.conversation_id ? `conversation ${ctx.conversation_id.slice(0, 8)}` : null, ctx.presence ? `presence ${ctx.presence.state}` : null, ctx.recent_events ? `${ctx.recent_events.length} recent events` : null];
  return parts.filter(Boolean).join(" · ");
}
