/**
 * The centre column: one thread's card, its transcript and its composer.
 *
 * It owns the two things the three of them disagree about on their own —
 * which state the whole column is in, and where a prompt you just sent
 * appears before the machine has said anything back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendPrompt } from "../api/client";
import { mergeEchoes, type Echo } from "../lib/blocks";
import { useTranscript } from "../lib/transcript";
import { Composer } from "./Composer";
import { ThreadHeader } from "./ThreadHeader";
import { Transcript } from "./Transcript";
import type { Project, Thread, ThreadHeader as HeaderData } from "../../shared/api";

export interface ThreadViewProps {
  thread: Thread;
  project: Project;
  /** Opens the project's setup script, from the card's "Optional:" line. */
  onOpenSetup: () => void;
}

export function ThreadView({ thread, project, onOpenSetup }: ThreadViewProps) {
  // Nothing to tail until there is a conversation, and nothing worth tailing
  // while the opening turn is still cutting the branch — the card reports that
  // one, and it reports it better.
  const live = thread.conversationId !== null && thread.status !== "building";
  const { items, connected, error, reload } = useTranscript(thread.id, live);

  const [header, setHeader] = useState<HeaderData | null>(null);
  const [echoes, setEchoes] = useState<Echo[]>([]);

  // A new thread is a new conversation: neither the old card nor the old
  // browser's unanswered prompts belong to it.
  useEffect(() => {
    setHeader(null);
    setEchoes([]);
  }, [thread.id]);

  const shown = useMemo(() => mergeEchoes(items, echoes), [items, echoes]);

  // Read when a prompt is sent rather than closed over, so the echo lands after
  // whatever had arrived by then and not after whatever had arrived on mount.
  const newest = useRef(0);
  newest.current = items.length > 0 ? items[items.length - 1]!.eventId : 0;

  const send = useCallback(
    async (prompt: string) => {
      await sendPrompt(thread.id, prompt);
      setEchoes((es) => [...es, { key: `echo-${Date.now()}-${es.length}`, text: prompt, afterEventId: newest.current, at: new Date().toISOString() }]);
    },
    [thread.id],
  );

  const loading = live && !connected && items.length === 0 && !error;

  return (
    <div className="dd-th">
      <Transcript
        items={shown}
        loading={loading}
        error={error}
        onReload={reload}
        emptyHint={emptyHint(thread)}
        header={<ThreadHeader thread={thread} onOpenSetup={onOpenSetup} onHeader={setHeader} />}
      />

      {live && !connected && !error && shown.length > 0 && (
        <p className="fine dd-th-reconnecting">
          <span className="dot" /> Reconnecting to this thread. What is above may be a moment behind.
        </p>
      )}

      <Composer
        thread={thread}
        model={project.model}
        starters={header?.starters ?? []}
        showStarters={shown.length === 0}
        onSend={send}
      />
    </div>
  );
}

function emptyHint(thread: Thread): string {
  switch (thread.status) {
    case "building":
      return "The machine is still being built. The conversation starts when the first turn finishes.";
    case "failed":
      return "This thread's machine did not finish being built, so there is nothing to read.";
    case "closed":
      return "This thread is closed and nothing was said in it.";
    default:
      return "Nothing said yet. Ask for something, or take one of the suggestions below.";
  }
}
