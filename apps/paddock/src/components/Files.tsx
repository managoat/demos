/**
 * The box's filesystem, over the read-only sandbox routes.
 *
 * `GET /api/sandboxes/:id/{files,file,diff}` is the whole of it. Those calls
 * cost nothing, work whatever the tab is doing, and — importantly — do not
 * wake a parked machine, which is why this panel can be opened on a sleeping
 * box without starting it up.
 *
 * There is no write here and there will not be one, because Fountain offers no
 * way to change a machine from outside. To change something, say so in the
 * tab; the panel says as much rather than leaving people hunting for an edit
 * button that does not exist.
 */
import { useCallback, useEffect, useState } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { SandboxListing } from "../api/types";
import { decodeFile } from "../lib/protocol";

export function Files({ client, sandboxId, root }: { client: FountainClient; sandboxId: string; root: string }) {
  const [path, setPath] = useState(root);
  const [listing, setListing] = useState<SandboxListing | null>(null);
  const [file, setFile] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = useCallback(
    async (next: string) => {
      setLoading(true);
      setError(null);
      setFile(null);
      setDiff(null);
      try {
        setListing(await client.listFiles(sandboxId, next));
        setPath(next);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [client, sandboxId],
  );

  useEffect(() => {
    void open(root);
  }, [open, root]);

  async function show(name: string) {
    setLoading(true);
    setError(null);
    try {
      const full = `${path.replace(/\/+$/, "")}/${name}`;
      const f = await client.readFile(sandboxId, full);
      setFile({ path: full, text: decodeFile(f), truncated: f.truncated });
      setDiff(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  async function showDiff() {
    setLoading(true);
    setError(null);
    try {
      const d = await client.diff(sandboxId, path);
      setDiff(d.diff.trim() ? d.diff : "(no changes against the base)");
      setFile(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

  return (
    <div className="panel files">
      <header className="panel-head">
        <div>
          <h2>Files</h2>
          <p className="dim">
            <code>{path}</code>
          </p>
        </div>
        <div className="row-actions">
          <button className="ghost" onClick={() => void open(parent)} disabled={path === "/"}>
            up
          </button>
          <button className="ghost" onClick={() => void open(path)}>
            refresh
          </button>
          <button className="ghost" onClick={showDiff}>
            diff
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {loading && <p className="dim">reading…</p>}

      {file ? (
        <>
          <div className="editor-head">
            <h4>{file.path}</h4>
            <button className="ghost" onClick={() => setFile(null)}>
              back
            </button>
          </div>
          <pre className="code">{file.text}</pre>
          {file.truncated && <p className="fine">Truncated by the server.</p>}
        </>
      ) : diff !== null ? (
        <>
          <div className="editor-head">
            <h4>git diff</h4>
            <button className="ghost" onClick={() => setDiff(null)}>
              back
            </button>
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
      ) : (
        <ul className="rows">
          {listing?.entries.map((e) => (
            <li className="row file-row" key={e.name}>
              <span className="dim narrow">{e.type === "dir" ? "dir" : "file"}</span>
              <button className="linkish" onClick={() => (e.type === "dir" ? void open(`${path.replace(/\/+$/, "")}/${e.name}`) : void show(e.name))}>
                {e.name}
                {e.type === "dir" ? "/" : ""}
              </button>
              <span className="dim">{e.size === null ? "" : bytes(e.size)}</span>
            </li>
          ))}
          {listing && listing.entries.length === 0 && <li className="fine">empty</li>}
          {listing?.truncated && <li className="fine">Listing truncated by the server.</li>}
        </ul>
      )}

      <p className="fine">
        Read-only, on purpose: Fountain offers no way to run a command on a machine from outside. To change something here, ask
        for it in the tab.
      </p>
    </div>
  );
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
