/** Who is in the chat, and how to let someone else in: an email, or a link. */
import { useState } from "react";
import { shortName } from "../../shared/author";
import { api, joinUrl, type ChatDto, type SendDto } from "../lib/api";
import { describeError } from "../lib/errors";
import { navigate } from "../router";
import { useSession } from "../store";
import { Avatar } from "./Avatar";

export function People({ chat, onChanged }: { chat: ChatDto; onChanged: (next: { chat: ChatDto; sends: SendDto[] }) => void }) {
  const { me, toast, refreshChats } = useSession();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const owner = chat.role === "owner";

  async function add() {
    const e = email.trim().toLowerCase();
    if (!e) return;
    setBusy(true);
    try {
      onChanged(await api.addMember(chat.id, e));
      setEmail("");
      void refreshChats();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: string) {
    setBusy(true);
    try {
      const res = await api.removeMember(chat.id, e);
      if (res.left) {
        toast("You left the chat.");
        void refreshChats();
        navigate({ page: "home" });
        return;
      }
      onChanged(await api.chat(chat.id));
      void refreshChats();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function makeLink() {
    setBusy(true);
    try {
      await api.invite(chat.id);
      onChanged(await api.chat(chat.id));
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!chat.inviteToken) return;
    try {
      await navigator.clipboard.writeText(joinUrl(chat.inviteToken));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Could not copy — select the link and copy it.", "error");
    }
  }

  return (
    <div className="people">
      <div className="people-list">
        <Person email={chat.ownerEmail} me={me.email} tag="host" />
        {chat.members.map((m) => (
          <Person key={m.email} email={m.email} me={me.email} onRemove={owner || m.email === me.email ? () => void remove(m.email) : undefined} removeLabel={m.email === me.email ? "Leave" : "Remove"} busy={busy} />
        ))}
      </div>
      {owner && (
        <>
          <form
            className="people-add"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Invite by email" />
            <button type="submit" className="small" disabled={busy || !email.trim()}>
              Add
            </button>
          </form>
          <div className="people-link">
            {chat.inviteToken ? (
              <>
                <input readOnly value={joinUrl(chat.inviteToken)} onFocus={(e) => e.target.select()} />
                <button type="button" className="small" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button type="button" className="linklike tiny" onClick={() => void makeLink()} disabled={busy}>
                  new link
                </button>
              </>
            ) : (
              <button type="button" className="small" onClick={() => void makeLink()} disabled={busy}>
                Make an invite link
              </button>
            )}
          </div>
          <p className="muted tiny">Anyone signed in to Salon who opens the link joins. Everyone in here chats on your Fountain, and you pay for it.</p>
        </>
      )}
      {!owner && <p className="muted tiny">Hosted by {shortName(chat.ownerEmail)}. It runs on their Fountain; you are not charged.</p>}
    </div>
  );
}

function Person({ email, me, tag, onRemove, removeLabel, busy }: { email: string; me: string; tag?: string; onRemove?: () => void; removeLabel?: string; busy?: boolean }) {
  return (
    <div className="person">
      <Avatar email={email} size={24} />
      <span className="person-name">
        {shortName(email)}
        {email === me && <span className="muted"> (you)</span>}
      </span>
      {tag && <span className="tag">{tag}</span>}
      {onRemove && (
        <button type="button" className="linklike tiny" onClick={onRemove} disabled={busy}>
          {removeLabel}
        </button>
      )}
    </div>
  );
}
