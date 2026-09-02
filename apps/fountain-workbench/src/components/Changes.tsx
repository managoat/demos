/**
 * What the work on an item has come to: per computer, per checkout, the
 * branch it is on, how far ahead, which files moved, and the diff.
 *
 * Two sources, joined here. The *state* — branch, head, ahead/behind,
 * porcelain status, and the moment it changed — is what the hook inside the
 * sandbox posted (`/api/snapshots`, server/snapshots.ts). The *bytes* are
 * read live through the project proxy from Fountain's disk reads
 * (`GET /api/sandboxes/:id/diff`, ADR 0039): redacted of the sandbox's
 * secrets, paged, and with the whole file beside a hunk when review wants it.
 * A `snapshot` event on the project stream is the cue to pull again, so the
 * diff follows the agent's edits during a turn, not just at its end.
 *
 * Fountain reads a `ready` computer only and does not wake a parked one, so
 * when the machine is asleep the view shows the last state the hook reported
 * and says so. And Fountain reads under `/home/sprite` only, so a checkout
 * mounted elsewhere is named as the reason there is no diff, rather than a
 * blank. `git diff` never lists an untracked file; the status does, and each
 * one is a fold that reads the file when opened.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useProject } from "../store";
import { api, type ItemDto, type SnapshotDto } from "../lib/api";
import { basename, parseStatus, parseUnifiedDiff, type DiffFile, type StatusEntry } from "../lib/diff";
import { describeError, errorCode } from "../lib/errors";
import { computerLabel, relativeTime, type Computer } from "../lib/sidebar";
import { href } from "../router";
import type { SandboxDiff, SandboxFile } from "../types";
import { AgentAvatar } from "./AgentAvatar";

/** Where environments should mount a checkout for Fountain to be able to read it. */
export const READABLE_ROOT = "/home/sprite";
const WORK_DIR = `${READABLE_ROOT}/work`;

export function Changes({ item, computers }: { item: ItemDto; computers: Computer[] }) {
  const { lastSnapshot } = useProject();
  const snaps = useItemSnapshots(item.id);

  // A computer with a disk we can read now, or one the hook has reported on.
  const shown = computers.filter((c) => c.sandboxId && (c.live || snaps?.some((s) => s.computer === c.key)));
  if (shown.length === 0) return null;

  return (
    <section className="stack tight">
      <h2 className="h2 section">Changes</h2>
      {shown.map((comp) => (
        <ComputerChanges key={comp.key} comp={comp} loaded={snaps !== null} snaps={(snaps ?? []).filter((s) => s.computer === comp.key)} tick={lastSnapshot?.computer === comp.key ? lastSnapshot.at : 0} />
      ))}
    </section>
  );
}

/** The same checkout review, scoped to the computer behind one conversation. */
export function ConversationChanges({ item, computer, snaps, onClose }: { item: ItemDto; computer: Computer; snaps: SnapshotDto[] | null; onClose: () => void }) {
  const { project, lastSnapshot } = useProject();

  return (
    <aside className="conversation-changes" aria-label="Computer changes">
      <header className="conversation-changes-head">
        <div className="min0 grow">
          <div className="strong">Computer changes</div>
          <a className="muted small" href={href.item(project.id, item.id)}>
            View all changes on {item.title}
          </a>
        </div>
        <button type="button" className="icon" onClick={onClose} aria-label="Close computer changes" title="Close">
          ×
        </button>
      </header>
      <div className="conversation-changes-body">
        <ComputerChanges
          comp={computer}
          loaded={snaps !== null}
          snaps={(snaps ?? []).filter((s) => s.computer === computer.key)}
          tick={lastSnapshot?.computer === computer.key ? lastSnapshot.at : 0}
        />
      </div>
    </aside>
  );
}

/** Snapshot state shared by the work-item view and a conversation's badge/panel. */
export function useItemSnapshots(itemId: string | null): SnapshotDto[] | null {
  const { project, lastSnapshot, toast } = useProject();
  const [snaps, setSnaps] = useState<SnapshotDto[] | null>(null);

  const load = useCallback(
    () => {
      if (!itemId) return;
      void api
        .snapshots(project.id, itemId)
        .then(setSnaps)
        .catch((err) => toast(describeError(err), "error"));
    },
    [project.id, itemId, toast],
  );
  useEffect(() => {
    setSnaps(null);
    load();
  }, [load]);
  // The hook posted: re-read the state, and the computer it names pulls its diff again.
  useEffect(() => {
    if (itemId && lastSnapshot?.itemId === itemId) load();
  }, [lastSnapshot, itemId, load]);
  return snaps;
}

/** Number on the conversation affordance: files in this computer's latest checkout states. */
export function snapshotFileCount(snaps: SnapshotDto[], computer: string): number {
  const byRepo = new Map<string, SnapshotDto>();
  for (const snap of snaps) {
    if (snap.computer !== computer) continue;
    const have = byRepo.get(snap.repo);
    if (!have || snap.takenAt > have.takenAt) byRepo.set(snap.repo, snap);
  }
  const files = new Set<string>();
  for (const snap of byRepo.values()) {
    for (const entry of parseStatus(snap.status).entries) {
      if (entry.kind !== "ignored") files.add(`${snap.repo}:${entry.path}`);
    }
  }
  return files.size;
}

function ComputerChanges({ comp, loaded, snaps, tick }: { comp: Computer; loaded: boolean; snaps: SnapshotDto[]; tick: number }) {
  const { fountain, agents } = useProject();
  const agent = comp.agentId ? agents.get(comp.agentId) ?? null : null;
  const ready = comp.sandbox?.status === "ready";
  const sandboxId = comp.sandboxId!;
  const reported = useMemo(() => [...new Set(snaps.map((s) => s.repo))].sort(), [snaps]);
  const [found, setFound] = useState<string[]>([]);

  // No hook on this machine (an environment that never installed it): look
  // where checkouts are mounted for Fountain to read, and offer those. Only
  // once the state has been read — before that, "none reported" is "not yet".
  useEffect(() => {
    if (!loaded || reported.length > 0 || !ready) return;
    let stale = false;
    fountain
      .sandboxFiles(sandboxId, WORK_DIR)
      .then((l) => {
        if (!stale) setFound(l.entries.filter((e) => e.type === "directory").map((e) => `${WORK_DIR}/${e.name}`));
      })
      .catch(() => {
        if (!stale) setFound([]);
      });
    return () => {
      stale = true;
    };
  }, [fountain, sandboxId, ready, loaded, reported.length]);

  const repos = reported.length > 0 ? reported : found;
  const status = comp.sandbox?.status ?? (comp.live ? "starting" : "gone");

  return (
    <div className={`computer ${comp.live ? "live" : "gone"}`}>
      <div className="computer-head static">
        {agent ? <AgentAvatar agent={agent} size={22} /> : <span className="computer-icon">🖥</span>}
        <div className="min0 grow">
          <span className="strong">{agent?.name ?? "computer"}</span>
          <span className="muted small"> · 🖥 {computerLabel(comp)} · {status}</span>
        </div>
        {comp.sandbox?.url && (
          <a className="button secondary small" href={comp.sandbox.url} target="_blank" rel="noreferrer" title="What the machine is serving, if anything">
            Preview ↗
          </a>
        )}
      </div>
      <div className="stack tight pad">
        {!ready && <p className="muted small">Fountain reads a running computer only; this one is {status}. {snaps.length > 0 ? "Below is the last state its hook reported." : ""}</p>}
        {repos.length === 0 && ready && <p className="muted small">No checkout reported yet, and nothing under {WORK_DIR}. The hook posts on the agent's first edit.</p>}
        {repos.map((repo) => (
          <RepoChanges key={repo} sandboxId={sandboxId} ready={ready} repo={repo} snap={latest(snaps, repo)} tick={tick} />
        ))}
      </div>
    </div>
  );
}

function latest(snaps: SnapshotDto[], repo: string): SnapshotDto | null {
  return snaps.filter((s) => s.repo === repo).sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0] ?? null;
}

/** Fountain's answer, said in words the view can show. */
export function diskError(err: unknown, repo: string): string {
  switch (errorCode(err)) {
    case "sandbox_not_ready":
      return "The computer is parked. Fountain does not wake one to read it; the next prompt will.";
    case "path_outside_sandbox":
      return `Fountain reads under ${READABLE_ROOT} only, and this checkout is at ${repo}. Mount it under ${WORK_DIR} in the environment.`;
    case "not_a_repository":
      return `${repo} is not a git repository.`;
    case "path_not_found":
      return `${repo} is no longer on the machine.`;
    default:
      return describeError(err);
  }
}

function RepoChanges({ sandboxId, ready, repo, snap, tick }: { sandboxId: string; ready: boolean; repo: string; snap: SnapshotDto | null; tick: number }) {
  const { fountain } = useProject();
  const [diff, setDiff] = useState<SandboxDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const pull = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      setDiff(await fountain.sandboxDiff(sandboxId, { path: repo }));
      setError(null);
    } catch (err) {
      setError(diskError(err, repo));
    } finally {
      setLoading(false);
    }
  }, [fountain, sandboxId, repo, ready]);
  useEffect(() => void pull(), [pull, tick]);

  const status = useMemo(() => (snap ? parseStatus(snap.status) : null), [snap]);
  const files = useMemo(() => (diff ? parseUnifiedDiff(diff.diff) : []), [diff]);
  const untracked = status?.entries.filter((e) => e.kind === "untracked") ?? [];
  const inDiff = new Set(files.map((f) => f.path));
  // Files the status names that the diff does not: with a diff in hand those
  // are the untracked ones; without one, every file the hook saw moving.
  const listed = (status?.entries ?? []).filter((e) => e.kind !== "ignored" && e.kind !== "untracked" && (!diff || !inDiff.has(e.path)));

  return (
    <div className="repo-changes">
      <div className="repo-head">
        <code>{basename(repo)}</code>
        {snap && (
          <>
            <span className="strong">{snap.branch || status?.head || "?"}</span>
            {snap.head && <span className="muted">{snap.head.slice(0, 8)}</span>}
            {snap.upstream && (
              <span className="muted">
                {snap.ahead} ahead · {snap.behind} behind {snap.upstream}
              </span>
            )}
            <span className="muted small">
              via {snap.source} {relativeTime(snap.takenAt)}
            </span>
          </>
        )}
        <span className="grow" />
        <button className="secondary small" onClick={() => void pull()} disabled={!ready || loading} title={ready ? "Read the diff from the machine again" : "The computer is not running"}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {error && <p className="muted small">{error}</p>}
      {listed.length > 0 && (
        <ul className="file-list">
          {listed.map((e) => (
            <FileRow key={`${e.kind}:${e.path}`} entry={e} />
          ))}
        </ul>
      )}
      {files.map((f) => (
        <DiffFileView key={f.path} file={f} />
      ))}
      {untracked.map((u) => (
        <UntrackedFile key={u.path} sandboxId={sandboxId} ready={ready} path={`${repo}/${u.path}`} name={u.path} />
      ))}
      {diff?.truncated && <p className="muted small">Fountain cut the diff at its limit; the rest is on the machine.</p>}
      {diff && files.length === 0 && untracked.length === 0 && listed.length === 0 && <p className="muted small">Clean: nothing differs from HEAD.</p>}
    </div>
  );
}

function FileRow({ entry }: { entry: StatusEntry }) {
  return (
    <li>
      <span className={`file-kind ${entry.kind}`}>{entry.kind}</span> <code>{entry.path}</code>
      {entry.origPath && <span className="muted small"> ← {entry.origPath}</span>}
    </li>
  );
}

function DiffFileView({ file }: { file: DiffFile }) {
  return (
    <details className="diff-file" open={file.hunks.length > 0 && file.additions + file.deletions <= 400}>
      <summary>
        <span className={`file-kind ${file.status}`}>{file.status}</span>
        <code>{file.path}</code>
        {file.status === "renamed" && file.oldPath && <span className="muted small">← {file.oldPath}</span>}
        <span className="muted small">
          +{file.additions} −{file.deletions}
        </span>
      </summary>
      {file.status === "binary" ? (
        <p className="muted small pad">Binary file.</p>
      ) : (
        <div className="diff-wrap">
          <table className="diff">
            <tbody>
              {file.hunks.map((h, i) => (
                <HunkRows key={i} header={h.header} lines={h.lines} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function HunkRows({ header, lines }: { header: string; lines: DiffFile["hunks"][number]["lines"] }): ReactNode {
  return (
    <>
      <tr className="meta">
        <td className="no" />
        <td className="no" />
        <td>{header}</td>
      </tr>
      {lines.map((l, i) => (
        <tr key={i} className={l.kind}>
          <td className="no">{l.old ?? ""}</td>
          <td className="no">{l.new ?? ""}</td>
          <td>
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            {l.text}
          </td>
        </tr>
      ))}
    </>
  );
}

/** A file git does not know yet: read when opened, shown as all additions. */
function UntrackedFile({ sandboxId, ready, path, name }: { sandboxId: string; ready: boolean; path: string; name: string }) {
  const { fountain } = useProject();
  const [file, setFile] = useState<SandboxFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = () => {
    if (file || !ready) return;
    fountain
      .sandboxFile(sandboxId, path)
      .then(setFile)
      .catch((err) => setError(diskError(err, path)));
  };
  const lines = file && file.encoding === "utf-8" ? file.content.replace(/\n$/, "").split("\n") : [];

  return (
    <details className="diff-file" onToggle={(e) => e.currentTarget.open && read()}>
      <summary>
        <span className="file-kind untracked">untracked</span>
        <code>{name}</code>
        {file && <span className="muted small">{file.size} bytes</span>}
      </summary>
      {!ready && <p className="muted small pad">The computer is not running, so the file cannot be read.</p>}
      {error && <p className="muted small pad">{error}</p>}
      {file && file.encoding !== "utf-8" && <p className="muted small pad">Binary file.</p>}
      {file && file.encoding === "utf-8" && (
        <div className="diff-wrap">
          <table className="diff">
            <tbody>
              {lines.map((t, i) => (
                <tr key={i} className="add">
                  <td className="no" />
                  <td className="no">{i + 1}</td>
                  <td>+{t}</td>
                </tr>
              ))}
              {file.truncated && (
                <tr className="meta">
                  <td className="no" />
                  <td className="no" />
                  <td>… cut at Fountain's limit</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
