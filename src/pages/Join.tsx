import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { describeError } from "../lib/errors";
import { navigate } from "../router";
import { useSession } from "../store";

/** A join link: take it up and land in the chat. */
export function Join({ token }: { token: string }) {
  const { refreshChats } = useSession();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .join(token)
      .then((chat) => {
        if (cancelled) return;
        void refreshChats();
        navigate({ page: "chat", id: chat.id });
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token, refreshChats]);
  return (
    <div className="empty">
      {error ? (
        <>
          <p className="error">{error}</p>
          <a href="#/">Back</a>
        </>
      ) : (
        <p className="muted">Joining…</p>
      )}
    </div>
  );
}
