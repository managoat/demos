/**
 * One track: the ribbon that says what it is, the transcript, and the box you
 * type into.
 *
 * The ribbon is the part worth explaining. Conductor puts four lines at the
 * top of a new thread — what it is a copy of, what it branched from, what it
 * created, and an offer to add a setup script — and they are not decoration.
 * They are the answer to the question somebody actually has when a machine
 * hands them a directory: *where am I, and what is under me?* Switchyard shows
 * the same four, with one difference forced by the architecture: the worktree
 * is cut by a turn on a real machine, so for the first few seconds those lines
 * describe something that is still being made. They say so rather than showing
 * a fact that is not true yet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogEvent } from "../../shared/fountain-types";
import type { Capabilities, Project, Track, TrackHeader } from "../../shared/api";
import { api, ApiError, subscribe } from "../lib/api";
import { Branch, Clock, External, Folder, Info, Issue, Pull, Wrench } from "../lib/icons";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

export interface TrackViewProps {
  project: Project;
  track: Track;
  header: TrackHeader;
  starters: { label: string; prompt: string }[];
  capabilities: Capabilities;
  onError: (message: string) => void;
  onOpenSettings: () => void;
  /** Called when a turn starts or ends, so the rail's dot agrees with the view. */
  onActivity: () => void;
}

export function TrackView(props: TrackViewProps) {
  const { project, track, header, starters } = props;
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [running, setRunning] = useState(track.status === "running" || track.status === "opening");
  const seen = useRef(new Set<number>());

  // The transcript so far, then the live stream. Two sources into one list,
  // de-duplicated by event id — the stream can replay an event the fetch
  // already returned, and a duplicated tool chip is very visible.
  useEffect(() => {
    let alive = true;
    seen.current = new Set();
    setEvents([]);
    void api
      .events(track.id)
      .then((list) => {
        if (!alive) return;
        for (const e of list) seen.current.add(e.id);
        setEvents(list);
      })
      .catch((err: unknown) => {
        if (alive && err instanceof ApiError) props.onError(err.message);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  useEffect(() => {
    const stop = subscribe(`/api/tracks/${track.id}/stream`, {
      // Fountain names its frames by kind; `message` is the fallback for a
      // stream that does not.
      message: (data) => absorb(data),
      event: (data) => absorb(data),
      log: (data) => absorb(data),
      turn: () => props.onActivity(),
    });
    function absorb(data: unknown): void {
      const ev = data as LogEvent | { events?: LogEvent[] } | null;
      if (!ev) return;
      const list = Array.isArray((ev as { events?: LogEvent[] }).events)
        ? (ev as { events: LogEvent[] }).events
        : [ev as LogEvent];
      const fresh = list.filter((e) => typeof e?.id === "number" && !seen.current.has(e.id));
      if (!fresh.length) return;
      for (const e of fresh) seen.current.add(e.id);
      setEvents((current) => [...current, ...fresh]);
      // A `state` on a stage event is how Fountain says a turn began or ended.
      for (const e of fresh) {
        if (e.kind === "stage" && e.state === "started") setRunning(true);
        if (e.kind === "stage" && (e.state === "completed" || e.state === "failed")) {
          setRunning(false);
          props.onActivity();
        }
      }
    }
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  const send = useCallback(
    async (text: string) => {
      setRunning(true);
      try {
        await api.prompt(track.id, text);
        props.onActivity();
      } catch (err) {
        setRunning(false);
        if (err instanceof ApiError) props.onError(err.message);
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track.id],
  );

  const interrupt = useCallback(() => {
    void api.interrupt(track.id).catch((err: unknown) => {
      if (err instanceof ApiError) props.onError(err.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  const empty = events.length === 0;

  return (
    <div className="centre">
      <Transcript
        events={events}
        runtime={project.runtime}
        running={running}
        head={
          <Ribbon
            project={project}
            track={track}
            header={header}
            onOpenSettings={props.onOpenSettings}
            onRetry={() => {
              void api.retry(track.id).catch((err: unknown) => {
                if (err instanceof ApiError) props.onError(err.message);
              });
            }}
          />
        }
      />

      {empty && !running ? (
        <div className="starters">
          {starters.map((s) => (
            <button key={s.label} type="button" className="starter" onClick={() => void send(s.prompt)}>
              {s.label}
            </button>
          ))}
        </div>
      ) : null}

      <Composer
        onSend={send}
        onInterrupt={interrupt}
        running={running}
        model={project.model}
        placeholder={
          track.status === "opening"
            ? "The worktree is still being cut — anything you send now runs straight after"
            : "Ask for a change, or a question about this branch"
        }
      />
    </div>
  );
}

/** The four lines at the top of a track. */
function Ribbon({
  project,
  track,
  header,
  onOpenSettings,
  onRetry,
}: {
  project: Project;
  track: Track;
  header: TrackHeader;
  onOpenSettings: () => void;
  onRetry: () => void;
}) {
  const opening = track.status === "opening";
  const failed = track.status === "failed";
  const originIcon = useMemo(() => {
    if (track.origin.kind === "pr") return <Pull size={14} />;
    if (track.origin.kind === "issue") return <Issue size={14} />;
    return <Branch size={14} />;
  }, [track.origin.kind]);

  return (
    <div className="ribbon">
      <div className="ribbon-lede">
        {header.copyOf ? (
          <>
            You are in a copy of <code>{header.copyOf}</code> called <code>{track.slug}</code>
          </>
        ) : (
          <>
            You are on a bare machine, in <code>{track.slug}</code>
          </>
        )}
      </div>

      {header.branchedFrom ? (
        <div className={`ribbon-line${opening ? " pending" : ""}`}>
          <span className="ico">{originIcon}</span>
          <span>
            {opening ? "Branching" : "Branched"} <code>{header.branchedFrom.branch}</code>
            {header.branchedFrom.base ? (
              <>
                {" "}
                from <code>origin/{header.branchedFrom.base}</code>
              </>
            ) : null}
          </span>
          {track.origin.url ? (
            <a href={track.origin.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
              <External size={12} />
            </a>
          ) : null}
        </div>
      ) : null}

      <div className={`ribbon-line${opening ? " pending" : ""}`}>
        <span className="ico">
          <Folder size={14} />
        </span>
        <span>
          {opening ? "Creating" : "Created"} <code>{track.workdir}</code>
        </span>
      </div>

      {failed ? (
        <div className="ribbon-line">
          <span className="ico">
            <Info size={14} />
          </span>
          <span className="error">The opening turn did not land, so this track may have no worktree yet.</span>
          <button type="button" className="linkish" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}

      {opening ? (
        <div className="ribbon-line pending">
          <span className="ico">
            <Clock size={14} />
          </span>
          <span>
            The machine is cutting it now — this is a turn, and you are watching it below. The box may be waking, which
            takes a moment the first time.
          </span>
        </div>
      ) : null}

      {!header.hasSetupScript && project.repo ? (
        <div className="ribbon-line">
          <span className="ico">
            <Wrench size={14} />
          </span>
          <button type="button" className="linkish" onClick={onOpenSettings}>
            Optional: add a setup script
          </button>
          <span className="dimmer">— it runs when the disk is built</span>
        </div>
      ) : null}
    </div>
  );
}
