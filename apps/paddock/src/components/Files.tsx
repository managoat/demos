/**
 * The box's filesystem: what changed, then everything else.
 *
 * Two things happened to this panel. The first was a tree that walked one
 * directory at a time and replaced the listing on every step, so you could
 * never see where you were; directories stay open now and siblings stay
 * visible. The second was the split — a 170px tree beside a code pane, in a
 * sidebar barely 360px wide, which starved both. The file moved into a modal
 * that gets the window instead, and the tree got the sidebar to itself.
 *
 * Above the tree is the answer to the question people actually open this
 * panel with. `git diff` was a button that dumped one string into a `<pre>`;
 * it is now a list of changed files with their counts, parsed by `lib/diff`,
 * and a changed file is marked in the tree where it sits. Clicking either
 * opens the same modal, on the diff.
 *
 * `GET /api/sandboxes/:id/{files,file,diff}` is still the whole of it. Those
 * calls cost nothing, work whatever the tabs are doing, and do not wake a
 * parked machine — which is why a tree that fetches a directory per expansion
 * and a panel that re-reads the diff on every refresh are both affordable.
 *
 * There is no write here and there will not be one: Fountain offers no way to
 * change a machine from outside. To change something, say so in the tab.
 */
import { useCallback, useEffect, useState } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { SandboxEntry, SandboxListing } from "../api/types";
import type { ChangeStatus, FileChange } from "../lib/diff";
import { absolutePath, diffLines, splitDiff, statusLetter } from "../lib/diff";
import { childPath, isDir, isOpenable, sortEntries } from "../lib/files";
import { decodeFile } from "../lib/protocol";

interface Loaded {
  entries: SandboxEntry[];
  truncated: boolean;
}

/** What the diff route said, once it has been read. */
interface Changes {
  repoRoot: string;
  files: FileChange[];
  /** Set only when nothing parsed as a file section — shown as-is rather than as "no changes". */
  raw: string | null;
  truncated: boolean;
}

/** What the modal is showing. A file, the whole diff, or a file's own diff. */
interface Target {
  /** Absolute, for the file route. Null for the whole-repository diff, which is not a file. */
  path: string | null;
  label: string;
  /** The line under the title. Not always the path: a delete has none left. */
  subtitle: string;
  /** The diff to show, when there is one. */
  change: FileChange | null;
  /** The whole-repository diff, when that is what was asked for. */
  whole: string | null;
  view: "file" | "diff";
}

type Open = Record<string, boolean>;
type Cache = Record<string, Loaded>;

export function Files({ client, sandboxId, root }: { client: FountainClient; sandboxId: string; root: string }) {
  const [cache, setCache] = useState<Cache>({});
  const [open, setOpen] = useState<Open>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [changes, setChanges] = useState<Changes | null>(null);
  // Its own error: a working directory that is not a git checkout is a normal
  // state, and it must not take the file tree down with it.
  const [changesError, setChangesError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading((m) => ({ ...m, [path]: true }));
      setError(null);
      try {
        const listing: SandboxListing = await client.listFiles(sandboxId, path);
        setCache((m) => ({ ...m, [path]: { entries: sortEntries(listing.entries), truncated: listing.truncated } }));
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading((m) => ({ ...m, [path]: false }));
      }
    },
    [client, sandboxId],
  );

  const loadChanges = useCallback(async () => {
    setChangesError(null);
    try {
      const d = await client.diff(sandboxId, root);
      const files = splitDiff(d.diff);
      setChanges({
        repoRoot: d.repo_root || root,
        files,
        raw: files.length === 0 && d.diff.trim() ? d.diff : null,
        truncated: d.truncated,
      });
    } catch (err) {
      setChanges(null);
      setChangesError(describeError(err));
    }
  }, [client, sandboxId, root]);

  // The tab's working directory is the root, and it starts open: a tree that
  // opens closed makes you click once before it has told you anything.
  useEffect(() => {
    setCache({});
    setOpen({ [root]: true });
    setSelected(null);
    setTarget(null);
    void load(root);
    void loadChanges();
  }, [root, load, loadChanges]);

  function toggle(path: string) {
    const next = !open[path];
    setOpen((m) => ({ ...m, [path]: next }));
    if (next && !cache[path]) void load(path);
  }

  function refresh() {
    const paths = Object.keys(open).filter((p) => open[p]);
    setCache({});
    for (const p of paths) void load(p);
    void loadChanges();
  }

  /** Open a file from the tree — on its diff when it has one, since that is the part you came for. */
  function openPath(path: string) {
    setSelected(path);
    const change = changeAt(changes, path);
    setTarget({ path, label: path.split("/").pop() ?? path, subtitle: path, change, whole: null, view: change ? "diff" : "file" });
  }

  /** Open a row of the Changes list. A delete has no file left to read. */
  function openChange(change: FileChange) {
    const path = changes ? absolutePath(changes.repoRoot, change.path) : null;
    if (path && change.status !== "deleted") setSelected(path);
    setTarget({
      path: change.status === "deleted" ? null : path,
      label: change.path,
      // A deleted file has no bytes to offer, so say where it was rather than
      // pointing at a path that no longer answers.
      subtitle: change.status === "deleted" ? `${path ?? change.path} — deleted` : (path ?? change.path),
      change,
      whole: null,
      view: "diff",
    });
  }

  const marks = changeMarks(changes);

  return (
    <div className="panel files">
      <header className="panel-head">
        <div className="head-copy">
          <h2>Files</h2>
          <p className="dim clip">
            <code>{root}</code>
          </p>
        </div>
        <div className="row-actions">
          <button className="ghost" onClick={refresh}>
            refresh
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="changes">
        <div className="section-head row">
          <h4 className="loud">
            Changes{changes && changes.files.length > 0 ? <span className="dim"> {changes.files.length}</span> : null}
          </h4>
          <span className="spacer" />
          {changes && (changes.files.length > 0 || changes.raw) && (
            <button
              className="linkish"
              onClick={() =>
                setTarget({
                  path: null,
                  label: "git diff",
                  subtitle: changes.raw
                    ? changes.repoRoot
                    : `${changes.repoRoot} · ${changes.files.length} file${changes.files.length === 1 ? "" : "s"}`,
                  change: null,
                  whole: wholeDiff(changes),
                  view: "diff",
                })
              }
            >
              whole diff
            </button>
          )}
        </div>

        {changesError ? (
          // Usually "not a git repository". Worth saying plainly; not worth an alarm.
          <p className="fine">{changesError}</p>
        ) : !changes ? (
          <p className="fine">Reading…</p>
        ) : changes.files.length === 0 && !changes.raw ? (
          <p className="fine">Nothing changed against the base.</p>
        ) : changes.files.length === 0 ? (
          <p className="fine">The diff did not parse as files. Open the whole diff to read it.</p>
        ) : (
          <ul className="rows changed">
            {changes.files.map((c) => (
              <li key={`${c.status}:${c.from ?? ""}:${c.path}`}>
                <button className="change" onClick={() => openChange(c)} title={c.from ? `${c.from} → ${c.path}` : c.path}>
                  <span className={`mark ${c.status}`}>{statusLetter(c.status)}</span>
                  <span className="change-path clip">
                    {c.from && <span className="dim">{c.from} → </span>}
                    {c.path}
                  </span>
                  {c.binary ? (
                    <span className="dim stat">binary</span>
                  ) : (
                    <span className="stat">
                      {c.additions > 0 && <span className="add">+{c.additions}</span>}
                      {c.deletions > 0 && <span className="del">−{c.deletions}</span>}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {changes?.truncated && <p className="fine">The diff was truncated by the server.</p>}
      </section>

      <section>
        <div className="section-head row">
          <h4 className="loud">Tree</h4>
        </div>
        <div className="tree">
          <Node
            path={root}
            name={root.split("/").filter(Boolean).pop() ?? "/"}
            depth={0}
            cache={cache}
            open={open}
            loading={loading}
            selected={selected}
            marks={marks}
            onToggle={toggle}
            onOpenFile={openPath}
          />
        </div>
      </section>

      <p className="fine">
        Read-only, on purpose: Fountain offers no way to run a command on a machine from outside. To change something here, ask
        for it in the tab.
      </p>

      {target && <Viewer client={client} sandboxId={sandboxId} target={target} onView={(view) => setTarget({ ...target, view })} onClose={() => setTarget(null)} />}
    </div>
  );
}

/**
 * The file, full width, over the top of everything.
 *
 * It reads the file itself — the panel deliberately does not, so that opening
 * one costs a request only when somebody actually opens one. Esc and the
 * backdrop close it; the diff, when there is one, is a tab rather than a
 * second place to go looking.
 */
function Viewer({
  client,
  sandboxId,
  target,
  onView,
  onClose,
}: {
  client: FountainClient;
  sandboxId: string;
  target: Target;
  onView: (view: "file" | "diff") => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<{ path: string; text: string; size: number; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const { path, view } = target;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // Read once per file, not once per tab: the two tabs are two views of the
    // same open thing, and flipping between them should not cost a request.
    if (path === null) return;
    let live = true;
    setError(null);
    setFile(null);
    client
      .readFile(sandboxId, path)
      .then((f) => live && setFile({ path, text: decodeFile(f), size: f.size, truncated: f.truncated }))
      .catch((err) => live && setError(describeError(err)));
    return () => {
      live = false;
    };
  }, [client, sandboxId, path]);

  const body = target.whole ?? target.change?.body ?? null;

  return (
    <div className="modal-root">
      <div className="backdrop" onClick={onClose} />
      <div className="modal viewer-modal" role="dialog" aria-label={target.label}>
        <header className="modal-head">
          <div className="head-copy">
            <h3 className="clip">{target.label}</h3>
            <p className="fine clip">
              {target.subtitle}
              {file && !target.whole ? ` · ${bytes(file.size)}` : ""}
            </p>
          </div>
          <div className="row-actions">
            {body !== null && path !== null && (
              <>
                <button className={`ghost ${view === "file" ? "on" : ""}`} onClick={() => onView("file")}>
                  file
                </button>
                <button className={`ghost ${view === "diff" ? "on" : ""}`} onClick={() => onView("diff")}>
                  diff
                  {target.change && !target.change.binary ? (
                    <span className="stat">
                      {target.change.additions > 0 && <span className="add">+{target.change.additions}</span>}
                      {target.change.deletions > 0 && <span className="del">−{target.change.deletions}</span>}
                    </span>
                  ) : null}
                </button>
              </>
            )}
            <button className={`ghost ${wrap ? "on" : ""}`} onClick={() => setWrap((w) => !w)} title="Wrap long lines">
              wrap
            </button>
            <button className="x" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </header>

        {error && view === "file" && <p className="error">{error}</p>}

        {view === "diff" && body !== null ? (
          target.change?.binary ? (
            <p className="fine">A binary file. Git recorded that it changed and nothing about how.</p>
          ) : diffLines(body).length === 0 || (target.change && target.change.additions === 0 && target.change.deletions === 0 && !target.whole) ? (
            <p className="fine">{noHunks(target.change)}</p>
          ) : (
            <pre className={`code diff numbered ${wrap ? "wrap" : ""}`}>
              {diffLines(body).map((l, i) => (
                <span key={i} className={`line ${l.kind}`}>
                  <span className="ln old">{l.old ?? ""}</span>
                  <span className="ln new">{l.new ?? ""}</span>
                  <span className="lt">{l.text || " "}</span>
                </span>
              ))}
            </pre>
          )
        ) : view === "diff" ? (
          <p className="fine">Nothing to diff.</p>
        ) : file ? (
          <>
            <pre className={`code numbered ${wrap ? "wrap" : ""}`}>
              {file.text.replace(/\n$/, "").split("\n").map((text, i) => (
                <span key={i} className="line">
                  <span className="ln new">{i + 1}</span>
                  <span className="lt">{text || " "}</span>
                </span>
              ))}
            </pre>
            {file.truncated && <p className="fine">Truncated by the server.</p>}
          </>
        ) : (
          !error && <p className="fine">Reading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Why a change has no hunks. Git says this in two different ways and both are
 * normal: a rename it matched at 100% has nothing to show, and a mode change
 * has nothing to show either.
 */
function noHunks(change: FileChange | null): string {
  if (change?.status === "renamed") {
    return `Renamed from ${change.from ?? "somewhere else"}. The contents did not change, so git recorded no hunks.`;
  }
  return "No hunks — git recorded that this changed and nothing about how.";
}

function Node({
  path,
  name,
  depth,
  cache,
  open,
  loading,
  selected,
  marks,
  onToggle,
  onOpenFile,
}: {
  path: string;
  name: string;
  depth: number;
  cache: Cache;
  open: Open;
  loading: Record<string, boolean>;
  selected: string | null;
  marks: Record<string, ChangeStatus>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isOpen = !!open[path];
  const loaded = cache[path];

  return (
    <>
      <button className={`node dir ${isOpen ? "open" : ""}`} style={{ paddingLeft: depth * 12 + 6 }} onClick={() => onToggle(path)}>
        <span className="caret">{isOpen ? "▾" : "▸"}</span>
        <span className="node-name">{name}</span>
        {loading[path] && <span className="dim">…</span>}
      </button>
      {isOpen &&
        loaded &&
        loaded.entries.map((e) => {
          const child = childPath(path, e.name);
          const mark = marks[child];
          return isDir(e) ? (
            <Node
              key={child}
              path={child}
              name={e.name}
              depth={depth + 1}
              cache={cache}
              open={open}
              loading={loading}
              selected={selected}
              marks={marks}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ) : (
            <button
              key={child}
              className={`node file ${selected === child ? "selected" : ""} ${isOpenable(e) ? "" : "inert"}`}
              style={{ paddingLeft: (depth + 1) * 12 + 18 }}
              onClick={() => isOpenable(e) && onOpenFile(child)}
              disabled={!isOpenable(e)}
              title={isOpenable(e) ? child : `${child} — ${e.type}, not readable`}
            >
              <span className="node-name">
                {e.name}
                {e.type === "symlink" ? " ↗" : ""}
              </span>
              <span className="spacer" />
              {/* The same letter the Changes list uses, where the file lives. */}
              {mark && <span className={`mark ${mark}`}>{statusLetter(mark)}</span>}
              <span className="dim">{e.size === null ? "" : bytes(e.size)}</span>
            </button>
          );
        })}
      {isOpen && loaded && loaded.entries.length === 0 && (
        <div className="node empty" style={{ paddingLeft: (depth + 1) * 12 + 18 }}>
          empty
        </div>
      )}
      {isOpen && loaded?.truncated && (
        <div className="node empty" style={{ paddingLeft: (depth + 1) * 12 + 18 }}>
          … truncated by the server
        </div>
      )}
    </>
  );
}

/** Absolute path → status, so the tree can mark a file without searching the list per row. */
function changeMarks(changes: Changes | null): Record<string, ChangeStatus> {
  if (!changes) return {};
  const marks: Record<string, ChangeStatus> = {};
  for (const c of changes.files) marks[absolutePath(changes.repoRoot, c.path)] = c.status;
  return marks;
}

function changeAt(changes: Changes | null, path: string): FileChange | null {
  if (!changes) return null;
  return changes.files.find((c) => absolutePath(changes.repoRoot, c.path) === path) ?? null;
}

/** Reassembled rather than kept: the parsed sections are the whole diff, minus nothing. */
function wholeDiff(changes: Changes): string {
  return changes.raw ?? changes.files.map((f) => f.body).join("\n");
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
