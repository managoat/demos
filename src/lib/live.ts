/**
 * What Salon itself records about a chat, kept live: the games on the
 * board and the repository's changes. Read once, then followed on the
 * chat's own stream (server/hub.ts); a reconnect re-reads, since the stream
 * replays nothing. Fountain's conversation stream is Thread's business.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangesDto } from "../../shared/changes";
import type { CommentDto } from "../../shared/comments";
import type { GameDto } from "../../shared/games";
import type { ControlEventDto, PresenceDto, RoomNoteDto, ViewingTarget } from "../../shared/control";
import { api, chatStreamUrl, type PlanStateDto } from "./api";

export interface ChatLive {
  games: Map<string, GameDto>;
  /** Take a game record: kept if newer than the one held. */
  takeGame: (g: GameDto) => void;
  /** The latest snapshot of the repository, with its diff; null when the computer has reported none. */
  changes: ChangesDto | null;
  /** Review comments on it, by id. */
  comments: Map<string, CommentDto>;
  /** Take a comment record from a call's answer, so the panel need not wait for the stream. */
  takeComment: (c: CommentDto & { deleted?: boolean }) => void;
  /** Read the repository through Fountain now (server/files.ts). Not a turn; the record comes back and goes on the stream. */
  refreshChanges: (reason: "manual" | "stop") => Promise<ChangesDto>;
  plan: PlanStateDto | null;
  setPlan: (plan: PlanStateDto | null) => void;
  notes: Map<string, RoomNoteDto>;
  takeNote: (note: RoomNoteDto & { deleted?: boolean }) => void;
  presence: PresenceDto | null;
  updatePresence: (typing: boolean, viewing?: ViewingTarget | null) => void;
  controls: ControlEventDto[];
  activeTurn: { id: string; author: string; status: string } | null;
}

export function useChatLive(chatId: string): ChatLive {
  const [games, setGames] = useState<Map<string, GameDto>>(() => new Map());
  const [changes, setChanges] = useState<ChangesDto | null>(null);
  const changesSeq = useRef(0);
  const [comments, setComments] = useState<Map<string, CommentDto>>(() => new Map());
  const [plan, setPlan] = useState<PlanStateDto | null>(null);
  const [notes, setNotes] = useState<Map<string, RoomNoteDto>>(() => new Map());
  const [presence, setPresence] = useState<PresenceDto | null>(null);
  const [controls, setControls] = useState<ControlEventDto[]>([]);
  const [activeTurn, setActiveTurn] = useState<{ id: string; author: string; status: string } | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const presenceInput = useRef<{ typing: boolean; viewing: ViewingTarget | null }>({ typing: false, viewing: null });
  const takeComment = useCallback((c: CommentDto & { deleted?: boolean }) => {
    setComments((prev) => {
      const next = new Map(prev);
      if (c.deleted) next.delete(c.id);
      else next.set(c.id, c);
      return next;
    });
    if (c.anchorKind === "plan_node" || c.anchorKind === "plan_field") {
      setPlan((current) => current ? { ...current, comments: c.deleted ? current.comments.filter((comment) => comment.id !== c.id) : [...current.comments.filter((comment) => comment.id !== c.id), c] } : current);
    }
  }, []);
  const takeNote = useCallback((note: RoomNoteDto & { deleted?: boolean }) => {
    setNotes((previous) => {
      const next = new Map(previous);
      if (note.deleted) next.delete(note.id);
      else next.set(note.id, note);
      return next;
    });
  }, []);
  const updatePresence = useCallback((typing: boolean, viewing: ViewingTarget | null = presenceInput.current.viewing) => {
    presenceInput.current = { typing, viewing };
    void api.presence(chatId, { clientId: clientId.current, typing, viewing }).then(setPresence).catch(() => undefined);
  }, [chatId]);

  const refreshChanges = useCallback(
    async (reason: "manual" | "stop") => {
      const c = await api.refreshChanges(chatId, reason);
      if (c.seq >= changesSeq.current) {
        changesSeq.current = c.seq;
        setChanges(c);
      }
      return c;
    },
    [chatId],
  );

  const takeGame = useCallback((g: GameDto) => {
    setGames((prev) => {
      const have = prev.get(g.id);
      if (have && have.seq >= g.seq) return prev;
      const next = new Map(prev);
      next.set(g.id, g);
      return next;
    });
  }, []);

  useEffect(() => {
    setGames(new Map());
    setChanges(null);
    setComments(new Map());
    setPlan(null);
    setNotes(new Map());
    setPresence(null);
    setControls([]);
    setActiveTurn(null);
    changesSeq.current = 0;
    let stopped = false;
    let source: EventSource | null = null;
    let retry: number | null = null;
    let fetching: number | null = null;

    // The stream sends a changes record without its diff; the full one is one request, coalesced.
    const readChanges = () => {
      if (fetching !== null) return;
      fetching = window.setTimeout(() => {
        fetching = null;
        api
          .changes(chatId)
          .then((c) => {
            if (stopped || !c || c.seq < changesSeq.current) return;
            changesSeq.current = c.seq;
            setChanges(c);
          })
          .catch(() => undefined);
      }, 300);
    };
    const load = () => {
      api
        .games(chatId)
        .then((list) => {
          if (!stopped) for (const g of list) takeGame(g);
        })
        .catch(() => undefined);
      readChanges();
      api
        .comments(chatId)
        .then((list) => {
          if (!stopped) setComments(new Map(list.map((c) => [c.id, c])));
        })
        .catch(() => undefined);
      api.plan(chatId).then((value) => { if (!stopped) setPlan(value); }).catch(() => undefined);
      api.notes(chatId).then((list) => { if (!stopped) setNotes(new Map(list.map((note) => [note.id, note]))); }).catch(() => undefined);
      api.controlEvents(chatId).then((list) => { if (!stopped) setControls(list); }).catch(() => undefined);
      api.collaboration(chatId).then((value) => {
        if (!stopped) { setPresence(value.presence); setActiveTurn(value.activeTurn); }
      }).catch(() => undefined);
    };
    const open = () => {
      if (stopped) return;
      source = new EventSource(chatStreamUrl(chatId));
      source.addEventListener("game", (ev) => {
        try {
          takeGame(JSON.parse((ev as MessageEvent).data) as GameDto);
        } catch {
          // not ours
        }
      });
      source.addEventListener("changes", (ev) => {
        try {
          const c = JSON.parse((ev as MessageEvent).data) as ChangesDto;
          if (c.seq > changesSeq.current) readChanges();
        } catch {
          // not ours
        }
      });
      source.addEventListener("comment", (ev) => {
        try {
          takeComment(JSON.parse((ev as MessageEvent).data) as CommentDto & { deleted?: boolean });
        } catch {
          // not ours
        }
      });
      source.addEventListener("plan", (ev) => {
        try { setPlan(JSON.parse((ev as MessageEvent).data) as PlanStateDto); } catch { /* not ours */ }
      });
      source.addEventListener("note", (ev) => {
        try { takeNote(JSON.parse((ev as MessageEvent).data) as RoomNoteDto & { deleted?: boolean }); } catch { /* not ours */ }
      });
      source.addEventListener("presence", (ev) => {
        try { setPresence(JSON.parse((ev as MessageEvent).data) as PresenceDto); } catch { /* not ours */ }
      });
      source.addEventListener("control", (ev) => {
        try {
          const event = JSON.parse((ev as MessageEvent).data) as ControlEventDto;
          setControls((prior) => prior.some((item) => item.id === event.id) ? prior : [...prior, event]);
        } catch { /* not ours */ }
      });
      source.addEventListener("turn", (ev) => {
        try { setActiveTurn(JSON.parse((ev as MessageEvent).data) as { id: string; author: string; status: string } | null); } catch { /* not ours */ }
      });
      source.onopen = () => load(); // what changed while the stream was down
      source.onerror = () => {
        source?.close();
        source = null;
        if (!stopped) retry = window.setTimeout(open, 3000);
      };
    };
    load();
    open();
    return () => {
      stopped = true;
      source?.close();
      if (retry !== null) window.clearTimeout(retry);
      if (fetching !== null) window.clearTimeout(fetching);
    };
  }, [chatId, takeGame, takeComment, takeNote]);

  useEffect(() => {
    const input = () => ({ clientId: clientId.current, ...presenceInput.current });
    void api.presence(chatId, input()).then(setPresence).catch(() => undefined);
    const timer = window.setInterval(() => {
      void api.presence(chatId, input()).then(setPresence).catch(() => undefined);
      void api.collaboration(chatId).then((value) => setActiveTurn(value.activeTurn)).catch(() => undefined);
    }, 20_000);
    const leave = () => void api.leavePresence(chatId, input()).catch(() => undefined);
    window.addEventListener("pagehide", leave);
    return () => { window.clearInterval(timer); window.removeEventListener("pagehide", leave); leave(); };
  }, [chatId]);

  return { games, takeGame, changes, comments, takeComment, refreshChanges, plan, setPlan, notes, takeNote, presence, updatePresence, controls, activeTurn };
}
