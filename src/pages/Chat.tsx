import { useCallback, useEffect, useState } from "react";
import { shortName } from "../../shared/author";
import { modelLabel, runtimeLabel, type Runtime } from "../../shared/models";
import { api, ApiError, type ChatDto, type SendDto } from "../lib/api";
import { describeError } from "../lib/errors";
import { navigate } from "../router";
import { useSession } from "../store";
import { Avatar } from "../components/Avatar";
import { Popover } from "../components/Menu";
import { People } from "../components/People";
import { Thread } from "../components/Thread";

export function Chat({ id }: { id: string }) {
  const { toast, refreshChats, signOut } = useSession();
  const [state, setState] = useState<{ chat: ChatDto; sends: SendDto[] } | null>(null);
  const [missing, setMissing] = useState(false);
  const [people, setPeople] = useState(false);
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.chat(id));
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else if (err instanceof ApiError && err.status === 401) signOut();
      else toast(describeError(err), "error");
    }
  }, [id, toast, signOut]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing)
    return (
      <div className="empty">
        <p>No such chat, or you are not in it.</p>
        <a href="#/">Back</a>
      </div>
    );
  if (!state) return <div className="muted small center pad">Loading…</div>;

  const { chat, sends } = state;
  const owner = chat.role === "owner";
  const participants = [chat.ownerEmail, ...chat.members.map((m) => m.email)];

  async function saveTitle() {
    if (editing === null) return;
    const title = editing.trim();
    setEditing(null);
    if (title === chat.title) return;
    try {
      setState(await api.patchChat(chat.id, { title }));
      void refreshChats();
    } catch (err) {
      toast(describeError(err), "error");
    }
  }

  async function remove() {
    setMore(false);
    try {
      await api.deleteChat(chat.id);
      toast("Chat retired.");
      void refreshChats();
      navigate({ page: "home" });
    } catch (err) {
      toast(describeError(err), "error");
    }
  }

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          {editing !== null ? (
            <input
              className="title-input"
              value={editing}
              autoFocus
              onChange={(e) => setEditing(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveTitle();
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <h2 className="display" onClick={owner ? () => setEditing(chat.title) : undefined} title={owner ? "Rename" : undefined}>
              {chat.title}
            </h2>
          )}
          <div className="muted small">
            {owner ? "You host this chat" : `Hosted by ${shortName(chat.ownerEmail)}`} · {modelLabel(chat.settings.model)} on {runtimeLabel(chat.settings.runtime as Runtime)}
            {chat.settings.presetName ? ` · from ${chat.settings.presetName}` : ""}
            {chat.unavailable ? " · the host's key is not answering" : ""}
          </div>
        </div>
        <div className="chat-tools">
          <div className="pill-wrap">
            <button type="button" className={`people-btn${people ? " on" : ""}`} onClick={() => setPeople((p) => !p)} aria-haspopup="dialog" aria-expanded={people}>
              <span className="stack">
                {participants.slice(0, 4).map((e) => (
                  <Avatar key={e} email={e} size={22} />
                ))}
              </span>
              <span>{participants.length === 1 ? "Invite" : `${participants.length}`}</span>
            </button>
            <Popover open={people} onClose={() => setPeople(false)} align="right" className="people-pop">
              <People chat={chat} onChanged={setState} />
            </Popover>
          </div>
          {owner && (
            <div className="pill-wrap">
              <button type="button" className="icon" onClick={() => setMore((m) => !m)} aria-label="More">
                ⋯
              </button>
              <Popover open={more} onClose={() => setMore(false)} align="right">
                <button type="button" className="menu-item" onClick={() => setEditing(chat.title)}>
                  <span className="menu-label">Rename</span>
                </button>
                <TwoStep label="Retire this chat" onConfirm={() => void remove()} />
              </Popover>
            </div>
          )}
        </div>
      </header>
      <Thread chat={chat} sends={sends} onSent={() => void load()} />
    </div>
  );
}

function TwoStep({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className="menu-item danger" onClick={() => (armed ? onConfirm() : setArmed(true))}>
      <span className="menu-label">{armed ? `Sure? ${label}` : label}</span>
      {!armed && <span className="menu-detail">Tears the computer down. The transcript stays on Fountain.</span>}
    </button>
  );
}
