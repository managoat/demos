/**
 * The box's filesystem, as an editor shows one: a tree on the left that you
 * expand in place, and the file you picked on the right.
 *
 * The first version walked one directory at a time and replaced the listing on
 * every step, which meant you could never see where you were — the thing a
 * file tree is for. Directories now stay open, siblings stay visible, and the
 * path you are looking at is the one that is highlighted.
 *
 * `GET /api/sandboxes/:id/{files,file,diff}` is the whole of it. Those calls
 * cost nothing, work whatever the tabs are doing, and do not wake a parked
 * machine — which is why a tree that fetches a directory per expansion is
 * affordable.
 *
 * There is no write here and there will not be one: Fountain offers no way to
 * change a machine from outside. To change something, say so in the tab.
 */
import { useCallback, useEffect, useState } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { SandboxListing } from "../api/types";
import { decodeFile } from "../lib/protocol";

interface Entry {
  name: string;
  type: string;
  size: number | null;
}

interface Loaded {
  entries: Entry[];
  truncated: boolean;
}

type Open = Record<string, boolean>;
type Cache = Record<string, Loaded>;

export function Files({ client, sandboxId, root }: { client: FountainClient; sandboxId: string; root: string }) {
  const [cache, setCache] = useState<Cache>({});
  const [open, setOpen] = useState<Open>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
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

  // The tab's working directory is the root, and it starts open: a tree that
  // opens closed makes you click once before it has told you anything.
  useEffect(() => {
    setCache({});
    setOpen({ [root]: true });
    setSelected(null);
    setFile(null);
    setDiff(null);
    void load(root);
  }, [root, load]);

  function toggle(path: string) {
    const next = !open[path];
    setOpen((m) => ({ ...m, [path]: next }));
    if (next && !cache[path]) void load(path);
  }

  async function show(path: string) {
    setSelected(path);
    setDiff(null);
    setError(null);
    try {
      const f = await client.readFile(sandboxId, path);
      setFile({ path, text: decodeFile(f), truncated: f.truncated });
    } catch (err) {
      setFile(null);
      setError(describeError(err));
    }
  }

  async function showDiff() {
    setError(null);
    try {
      const d = await client.diff(sandboxId, root);
      setDiff(d.diff.trim() ? d.diff : "(no changes against the base)");
      setFile(null);
      setSelected(null);
    } catch (err) {
      setError(describeError(err));
    }
  }

  function refresh() {
    const paths = Object.keys(open).filter((p) => open[p]);
    setCache({});
    for (const p of paths) void load(p);
    if (file) void show(file.path);
  }

  return (
    <div className="panel files">
      <header className="panel-head">
        <div>
          <h2>Files</h2>
          <p className="dim">
            <code>{root}</code>
          </p>
        </div>
        <div className="row-actions">
          <button className="ghost" onClick={refresh}>
            refresh
          </button>
          <button className="ghost" onClick={() => void showDiff()}>
            diff
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="explorer">
        <div className="tree">
          <Node
            path={root}
            name={root.split("/").filter(Boolean).pop() ?? "/"}
            depth={0}
            cache={cache}
            open={open}
            loading={loading}
            selected={selected}
            onToggle={toggle}
            onOpenFile={(p) => void show(p)}
          />
        </div>

        <div className="viewer">
          {diff !== null ? (
            <>
              <div className="viewer-head">
                <span className="row-label">git diff</span>
                <span className="dim">{root}</span>
              </div>
              <pre className="code diff">
                {diff.split("\n").map((line, i) => (
                  <span key={i} className={diffClass(line)}>
                    {line}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </>
          ) : file ? (
            <>
              <div className="viewer-head">
                <span className="row-label">{file.path.split("/").pop()}</span>
                <span className="dim">{file.path}</span>
              </div>
              <pre className="code">{file.text}</pre>
              {file.truncated && <p className="fine">Truncated by the server.</p>}
            </>
          ) : (
            <p className="fine">Pick a file.</p>
          )}
        </div>
      </div>

      <p className="fine">
        Read-only, on purpose: Fountain offers no way to run a command on a machine from outside. To change something here, ask
        for it in the tab.
      </p>
    </div>
  );
}

function Node({
  path,
  name,
  depth,
  cache,
  open,
  loading,
  selected,
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
          const child = `${path.replace(/\/+$/, "")}/${e.name}`;
          return e.type === "dir" ? (
            <Node
              key={child}
              path={child}
              name={e.name}
              depth={depth + 1}
              cache={cache}
              open={open}
              loading={loading}
              selected={selected}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ) : (
            <button
              key={child}
              className={`node file ${selected === child ? "selected" : ""}`}
              style={{ paddingLeft: (depth + 1) * 12 + 18 }}
              onClick={() => onOpenFile(child)}
            >
              <span className="node-name">{e.name}</span>
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

/** Directories first, then files, each alphabetical — the order every editor uses. */
function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
