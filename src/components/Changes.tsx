/**
 * The Changes panel: what the chat's computer has done to the repository,
 * as the latest snapshot the server holds (shared/changes.ts) — the branch
 * and where it stands, the pull request when there is one, the files, and
 * each file's diff — with the room's review comments on its lines
 * (shared/comments.ts). Every browser in the chat draws the same records.
 *
 * A comment is not a turn. "Send to the model" is: the open comments go as
 * one prompt from whoever presses it, and each is marked sent.
 *
 * Refresh reads the repository through Fountain now (server/files.ts) —
 * not a turn either, and the way a chat on a runtime without the hook
 * gets a snapshot at all. Files browses the repository as it is in the
 * computer, one directory or one file at a time, the same way.
 */
import { useEffect, useMemo, useState } from "react";
import { shortName } from "../../shared/author";
import { changesLine, checks, parseDiff, shortSha, type ChangesDto, type FileDiff, type FileStatus } from "../../shared/changes";
import { pending, type CommentDto, type Side } from "../../shared/comments";
import { FILE_MAX_BYTES, joinPath, parentOf, segments, type DirListing, type FileContents } from "../../shared/files";
import { api } from "../lib/api";
import { describeError } from "../lib/errors";
import { formatTime } from "../lib/format";
import { useSession } from "../store";
import { Avatar } from "./Avatar";

/** A file with more lines than this starts folded. */
const FOLD_OVER = 400;

export interface Review {
  chatId: string;
  comments: Map<string, CommentDto>;
  takeComment: (c: CommentDto & { deleted?: boolean }) => void;
  /** True while a turn runs: comments still land, but a send would be refused. */
  busy: boolean;
  /** Send a prompt as the caller's turn — what the Push and Open a pull request buttons do. Null when the chat cannot take one. */
  sendPrompt: ((text: string) => Promise<void>) | null;
  /** Read the repository through Fountain now. Null when the chat has no repository, or no computer any more. */
  refresh: ((reason: "manual") => Promise<unknown>) | null;
}

type View = { kind: "diff" } | { kind: "dir"; path: string } | { kind: "file"; path: string };

export function ChangesPanel({ changes, review, onClose }: { changes: ChangesDto | null; review: Review; onClose: () => void }) {
  const { me, toast } = useSession();
  const files = useMemo(() => (changes ? parseDiff(changes.diff) : []), [changes]);
  const [current, setCurrent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<View>({ kind: "diff" });
  const all = useMemo(() => [...review.comments.values()], [review.comments]);
  const open = pending(all);

  const refresh = async () => {
    if (!review.refresh || refreshing) return;
    setRefreshing(true);
    try {
      await review.refresh("manual");
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setRefreshing(false);
    }
  };

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      const out = await api.sendComments(review.chatId);
      for (const c of out.comments) review.takeComment(c);
      toast(`${out.sent} comment${out.sent === 1 ? "" : "s"} sent to the model.`);
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="changes-panel" aria-label="Changes">
      <div className="changes-head">
        <div className="changes-title">
          <span className="display">Changes</span>
          {changes && <span className="muted small">{changesLine(changes.files)}</span>}
        </div>
        <div className="row">
          {review.refresh && (
            <button type="button" className={`tiny ghost${view.kind !== "diff" ? " on" : ""}`} onClick={() => setView((v) => (v.kind === "diff" ? { kind: "dir", path: "" } : { kind: "diff" }))} title="Browse the repository as it is in the computer now.">
              Files
            </button>
          )}
          {review.refresh && (
            <button type="button" className="icon" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh" title="Read the repository now, through Fountain. Not a turn.">
              {refreshing ? "…" : "↻"}
            </button>
          )}
          {open.length > 0 && (
            <button type="button" className="small send-comments" onClick={() => void send()} disabled={sending} title={review.busy ? "The model is still working; it will take these when the turn ends." : undefined}>
              {sending ? "Sending…" : `Send ${open.length} to the model`}
            </button>
          )}
          <button type="button" className="icon" onClick={onClose} aria-label="Close changes">
            ×
          </button>
        </div>
      </div>
      {view.kind !== "diff" && <FilesView chatId={review.chatId} view={view} onView={setView} />}
      {view.kind === "diff" && !changes && (
        <p className="muted small pad">
          Nothing yet. Once the computer has a repository and touches it, what changed shows here for everyone in the chat.
          {review.refresh ? " Press ↻ to read it now." : ""}
        </p>
      )}
      {view.kind === "diff" && changes && (
        <>
          <div className="changes-where small">
            <span className="mono">{changes.branch || shortSha(changes.head)}</span>
            {changes.head && <span className="muted mono">{shortSha(changes.head)}</span>}
            <span className="muted">
              against <span className="mono">{changes.base}</span>
            </span>
            <span className="muted" title={changes.source === "fountain" ? "Read through Fountain" : "Reported by the computer"}>
              · {formatTime(changes.at)}
            </span>
            {changes.source === "fountain" && changes.status.trim() === "" && <span className="muted tiny">untracked files not counted</span>}
            {changes.pr && (
              <a className="pr-link" href={changes.pr.url} target="_blank" rel="noreferrer">
                Pull request · {prWord(changes.pr.state)}
              </a>
            )}
          </div>
          <Checks changes={changes} openComments={open.length} review={review} />
          {changes.truncated && <div className="changes-note small">The diff was too long to keep whole; what is here is the first part of it.</div>}
          {files.length === 0 && <p className="muted small pad">The tree is clean: nothing differs from {changes.base}.</p>}
          {files.length > 0 && (
            <nav className="changes-files">
              {files.map((f) => {
                const n = all.filter((c) => c.path === f.path && !c.resolvedAt).length;
                return (
                  <a key={f.path} href={`#file-${encodeURIComponent(f.path)}`} className={`changes-file${current === f.path ? " on" : ""}`} onClick={() => setCurrent(f.path)}>
                    <span className={`file-status ${f.status}`}>{statusMark(f.status)}</span>
                    <span className="file-path">{f.path}</span>
                    {n > 0 && <span className="file-comments">💬 {n}</span>}
                    <span className="file-counts">
                      {f.additions > 0 && <span className="add">+{f.additions}</span>}
                      {f.deletions > 0 && <span className="del">−{f.deletions}</span>}
                    </span>
                  </a>
                );
              })}
            </nav>
          )}
          <div className="changes-body">
            {files.map((f) => (
              <FileView key={f.path} file={f} comments={all.filter((c) => c.path === f.path)} review={review} me={me.email} onOpen={review.refresh && f.status !== "deleted" ? () => setView({ kind: "file", path: f.path }) : null} />
            ))}
            {orphans(all, files).length > 0 && (
              <section className="file">
                <header className="file-head">
                  <span className="file-path">Comments on lines no longer in the diff</span>
                </header>
                {orphans(all, files).map((c) => (
                  <CommentView key={c.id} comment={c} review={review} me={me.email} where />
                ))}
              </section>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * What stands between the branch and a merge, and the two asks that move it
 * — each a prompt, so a turn, and labelled as one. Merge stays a request to
 * the model too, until Salon can run git itself.
 */
function Checks({ changes, openComments, review }: { changes: ChangesDto; openComments: number; review: Review }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const list = checks(changes);
  const ask = async (key: string, text: string) => {
    if (!review.sendPrompt || busy) return;
    setBusy(key);
    try {
      await review.sendPrompt(text);
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(null);
    }
  };
  const pushAsk = "Commit anything still uncommitted with a clear message, push the branch to origin, and say in a sentence what went up.";
  const prAsk = `Push the branch and open a pull request against ${changes.base} with \`gh pr create\`: a short title, a description of what changed and why, and say its address.`;
  const canAsk = !!review.sendPrompt && !review.busy;
  return (
    <div className="checks">
      {list.map((c) => (
        <span key={c.key} className={`check${c.ok ? " ok" : ""}`}>
          <span className="check-mark" aria-hidden="true">
            {c.ok ? "✓" : "○"}
          </span>
          {c.label}
        </span>
      ))}
      <span className={`check${openComments === 0 ? " ok" : ""}`}>
        <span className="check-mark" aria-hidden="true">
          {openComments === 0 ? "✓" : "○"}
        </span>
        {openComments === 0 ? "No open comments" : `${openComments} open comment${openComments === 1 ? "" : "s"}`}
      </span>
      {canAsk && (list.find((c) => c.key === "branch")?.ok === false || list.find((c) => c.key === "tree")?.ok === false) && (
        <button type="button" className="tiny ghost" disabled={busy !== null} onClick={() => void ask("push", pushAsk)} title="Asks the model to commit and push. It is a turn.">
          {busy === "push" ? "Asking…" : "Ask to push"}
        </button>
      )}
      {canAsk && !changes.pr && (
        <button type="button" className="tiny ghost" disabled={busy !== null} onClick={() => void ask("pr", prAsk)} title="Asks the model to open a pull request. It is a turn.">
          {busy === "pr" ? "Asking…" : "Ask for a pull request"}
        </button>
      )}
    </div>
  );
}

/** Comments whose file is not in the current diff: still shown, so nothing said is lost. */
function orphans(all: CommentDto[], files: FileDiff[]): CommentDto[] {
  const paths = new Set(files.map((f) => f.path));
  return all.filter((c) => !paths.has(c.path));
}

function FileView({ file, comments, review, me, onOpen }: { file: FileDiff; comments: CommentDto[]; review: Review; me: string; onOpen: (() => void) | null }) {
  const lines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lines <= FOLD_OVER || comments.length > 0);
  const [composing, setComposing] = useState<{ side: Side; line: number } | null>(null);
  const openCount = comments.filter((c) => !c.resolvedAt).length;
  return (
    <section className="file" id={`file-${encodeURIComponent(file.path)}`}>
      <header className="file-head" onClick={() => setOpen((o) => !o)}>
        <span className={`file-status ${file.status}`}>{statusMark(file.status)}</span>
        <span className="file-path">
          {file.oldPath && (
            <>
              <span className="muted">{file.oldPath}</span> →{" "}
            </>
          )}
          {file.path}
        </span>
        {openCount > 0 && <span className="file-comments">💬 {openCount}</span>}
        <span className="file-counts">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
        {onOpen && (
          <button
            type="button"
            className="linklike tiny"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            title="The whole file, as it is in the computer now."
          >
            open
          </button>
        )}
        <span className="muted tiny">{open ? "▾" : "▸"}</span>
      </header>
      {open && file.binary && <div className="muted small pad">A binary file.</div>}
      {open && !file.binary && file.hunks.length === 0 && <div className="muted small pad">{file.status === "renamed" ? "Renamed, unchanged." : "No lines changed."}</div>}
      {open && !file.binary && file.hunks.length > 0 && (
        <table className="diff">
          <tbody>
            {file.hunks.map((h, hi) => (
              <HunkRows key={hi} hunk={h} path={file.path} comments={comments} review={review} me={me} composing={composing} onCompose={setComposing} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function HunkRows({
  hunk,
  path,
  comments,
  review,
  me,
  composing,
  onCompose,
}: {
  hunk: FileDiff["hunks"][number];
  path: string;
  comments: CommentDto[];
  review: Review;
  me: string;
  composing: { side: Side; line: number } | null;
  onCompose: (c: { side: Side; line: number } | null) => void;
}) {
  return (
    <>
      <tr className="hunk">
        <td className="no" />
        <td className="no" />
        <td className="code">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.heading}
        </td>
      </tr>
      {hunk.lines.map((l, i) => {
        // A line lives on the new side unless it was removed; comments anchor there.
        const side: Side = l.type === "del" ? "old" : "new";
        const no = side === "new" ? l.newNo! : l.oldNo!;
        const here = comments.filter((c) => c.side === side && c.line === no);
        const isComposing = composing?.side === side && composing.line === no;
        return (
          <LineRows key={i} line={l} here={here} composing={isComposing} onCompose={() => onCompose(isComposing ? null : { side, line: no })} onDone={() => onCompose(null)} path={path} side={side} no={no} review={review} me={me} />
        );
      })}
    </>
  );
}

function LineRows({
  line: l,
  here,
  composing,
  onCompose,
  onDone,
  path,
  side,
  no,
  review,
  me,
}: {
  line: FileDiff["hunks"][number]["lines"][number];
  here: CommentDto[];
  composing: boolean;
  onCompose: () => void;
  onDone: () => void;
  path: string;
  side: Side;
  no: number;
  review: Review;
  me: string;
}) {
  return (
    <>
      <tr className={`${l.type}${here.length ? " commented" : ""}`}>
        <td className="no">{l.oldNo ?? ""}</td>
        <td className="no">{l.newNo ?? ""}</td>
        <td className="code">
          <button type="button" className="comment-add" onClick={onCompose} aria-label={`Comment on line ${no}`} title="Comment on this line">
            +
          </button>
          <span className="sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
          {l.text}
        </td>
      </tr>
      {(here.length > 0 || composing) && (
        <tr className="thread">
          <td className="no" />
          <td className="no" />
          <td className="code">
            {here.map((c) => (
              <CommentView key={c.id} comment={c} review={review} me={me} />
            ))}
            {composing && <Compose path={path} side={side} line={no} review={review} onDone={onDone} />}
          </td>
        </tr>
      )}
    </>
  );
}

function CommentView({ comment: c, review, me, where }: { comment: CommentDto; review: Review; me: string; where?: boolean }) {
  const { toast } = useSession();
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (err) {
      toast(describeError(err), "error");
    }
  };
  return (
    <div className={`comment${c.resolvedAt ? " resolved" : ""}${c.sentAt ? " sent" : ""}`}>
      <Avatar email={c.author} size={20} />
      <div className="comment-body">
        <div className="comment-meta">
          <span className="name">{c.author === me ? "You" : shortName(c.author)}</span>
          <span className="muted tiny">{formatTime(c.createdAt)}</span>
          {where && (
            <span className="muted tiny mono">
              {c.path}:{c.line}
            </span>
          )}
          {c.sentAt && <span className="tag">sent</span>}
          {c.resolvedAt && <span className="tag">resolved</span>}
        </div>
        {where && c.quote && <div className="comment-quote mono">{c.quote}</div>}
        <div className="comment-text">{c.body}</div>
        <div className="comment-actions">
          <button type="button" className="linklike tiny" onClick={() => void act(async () => review.takeComment(await api.resolveComment(review.chatId, c.id, !c.resolvedAt)))}>
            {c.resolvedAt ? "Reopen" : "Resolve"}
          </button>
          {c.author === me && !c.sentAt && (
            <button type="button" className="linklike tiny" onClick={() => void act(async () => (await api.deleteComment(review.chatId, c.id), review.takeComment({ ...c, deleted: true })))}>
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Compose({ path, side, line, review, onDone }: { path: string; side: Side; line: number; review: Review; onDone: () => void }) {
  const { toast } = useSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      review.takeComment(await api.comment(review.chatId, { path, side, line, body }));
      setText("");
      onDone();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="compose-comment"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Say what should change here"
        rows={2}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === "Escape") onDone();
        }}
      />
      <div className="row">
        <button type="submit" className="small" disabled={!text.trim() || busy}>
          Comment
        </button>
        <button type="button" className="small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The repository as it is now: one directory, or one file, read through Fountain when asked for. */
function FilesView({ chatId, view, onView }: { chatId: string; view: Exclude<View, { kind: "diff" }>; onView: (v: View) => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [file, setFile] = useState<FileContents | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const path = view.path;

  useEffect(() => {
    let stopped = false;
    setProblem(null);
    setLoading(true);
    const read = async () => {
      if (view.kind === "dir") {
        const l = await api.files(chatId, path);
        if (stopped) return;
        setListing(l);
        setFile(null);
      } else {
        const f = await api.file(chatId, path);
        if (stopped) return;
        setFile(f);
        setListing(null);
      }
    };
    read()
      .catch((err) => !stopped && setProblem(describeError(err)))
      .finally(() => !stopped && setLoading(false));
    return () => {
      stopped = true;
    };
  }, [chatId, view.kind, path]);

  const crumbs = segments(path);
  return (
    <div className="files">
      <nav className="files-crumbs small" aria-label="Where">
        <button type="button" className="linklike" onClick={() => onView({ kind: "dir", path: "" })}>
          repository
        </button>
        {crumbs.map((seg, i) => {
          const here = crumbs.slice(0, i + 1).join("/");
          const last = i === crumbs.length - 1;
          return (
            <span key={here}>
              <span className="muted"> / </span>
              {last ? <span className="mono">{seg}</span> : <button type="button" className="linklike mono" onClick={() => onView({ kind: "dir", path: here })}>{seg}</button>}
            </span>
          );
        })}
        {loading && <span className="muted"> …</span>}
      </nav>
      {problem && <p className="muted small pad">{problem}</p>}
      {!problem && view.kind === "dir" && listing && (
        <div className="files-list">
          {path && (
            <button type="button" className="files-entry" onClick={() => onView({ kind: "dir", path: parentOf(path) })}>
              <span className="file-kind">↰</span>
              <span className="file-path">..</span>
            </button>
          )}
          {listing.entries.length === 0 && <p className="muted small pad">An empty directory.</p>}
          {listing.entries.map((e) => (
            <button key={e.name} type="button" className="files-entry" disabled={e.type === "other"} onClick={() => onView(e.type === "directory" ? { kind: "dir", path: joinPath(path, e.name) } : { kind: "file", path: joinPath(path, e.name) })}>
              <span className="file-kind">{e.type === "directory" ? "▸" : e.type === "symlink" ? "↗" : " "}</span>
              <span className="file-path">{e.name}</span>
              {e.size !== null && <span className="muted tiny mono">{bytes(e.size)}</span>}
            </button>
          ))}
          {listing.truncated && <p className="muted small pad">More files than the listing could carry.</p>}
        </div>
      )}
      {!problem && view.kind === "file" && file && (
        <div className="files-file">
          <div className="muted tiny pad-x">
            {bytes(file.size)}
            {file.truncated ? ` · the first ${bytes(FILE_MAX_BYTES)} of it` : ""}
          </div>
          {file.encoding === "base64" ? <p className="muted small pad">Not a text file.</p> : <pre className="file-text">{file.content}</pre>}
        </div>
      )}
    </div>
  );
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusMark(s: FileStatus): string {
  switch (s) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "modified":
      return "M";
  }
}

function prWord(state: string): string {
  switch (state.toUpperCase()) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return state.toLowerCase();
  }
}
