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
import { api, chatStreamUrl } from "./api";

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
}

export function useChatLive(chatId: string): ChatLive {
  const [games, setGames] = useState<Map<string, GameDto>>(() => new Map());
  const [changes, setChanges] = useState<ChangesDto | null>(null);
  const changesSeq = useRef(0);
  const [comments, setComments] = useState<Map<string, CommentDto>>(() => new Map());
  const takeComment = useCallback((c: CommentDto & { deleted?: boolean }) => {
    setComments((prev) => {
      const next = new Map(prev);
      if (c.deleted) next.delete(c.id);
      else next.set(c.id, c);
      return next;
    });
  }, []);

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
  }, [chatId, takeGame, takeComment]);

  return { games, takeGame, changes, comments, takeComment, refreshChanges };
}
