import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Turn } from "../api/types";

/** A turn's attached images, fetched with the bearer key (an <img src> cannot send one). */
export function TurnImages({ conversationId, turn }: { conversationId: string; turn: Turn }) {
  const { client } = useStore();
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    Promise.all(
      Array.from({ length: turn.image_count }, (_, i) =>
        client
          .fetchRaw(client.imageUrl(conversationId, turn.id, i))
          .then((r) => (r.ok ? r.blob() : null))
          .then((b) => (b ? URL.createObjectURL(b) : null))
          .catch(() => null),
      ),
    ).then((list) => {
      if (cancelled) return;
      const ok = list.filter((u): u is string => !!u);
      made.push(...ok);
      setUrls(ok);
    });
    return () => {
      cancelled = true;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [client, conversationId, turn.id, turn.image_count]);

  if (!urls.length) return null;
  return (
    <div className="turn-images">
      {urls.map((u, i) => (
        <a key={i} href={u} target="_blank" rel="noreferrer">
          <img src={u} alt={`attachment ${i + 1}`} />
        </a>
      ))}
    </div>
  );
}
