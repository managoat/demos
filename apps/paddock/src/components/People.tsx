/**
 * Who is in *this tab*, and how to let somebody else into it.
 *
 * Invitations name a terminal, not the machine. Somebody let into Terminal 2
 * sees Terminal 2: not the other terminals, not what is on the rest of the
 * disk through them, and they cannot open a third. That is what the original
 * brief asked for — people invited to a thread — and it is a much smaller
 * thing to hand out than a whole computer.
 *
 * The warning is still the important part of the panel, because the reduction
 * is real but partial: a tab is a shell on the machine, so anyone who can type
 * into one can still ask the agent to read the disk. What per-tab invites buy
 * is that they cannot read *your other conversations*, and that revoking one
 * terminal does not disturb the rest.
 */
import { useState } from "react";
import type { Role, TabPeopleDto } from "../api/paddock";

export interface PeopleProps {
  /** Null while the tab's people are still loading. */
  tab: TabPeopleDto | null;
  /** What this terminal is called, for a panel that talks about one of them. */
  tabTitle: string;
  role: Role;
  meLabel: string;
  ownerEmail: string;
  here: { label: string; role: string }[];
  onInvite: (email: string) => Promise<void>;
  onRemove: (email: string) => Promise<void>;
  onMintLink: () => Promise<void>;
  onCloseLink: () => Promise<void>;
}

/**
 * The link, as something you can paste. The server builds it from PUBLIC_URL,
 * which is right in production and unset in dev; resolving it against the
 * current origin means a misconfiguration degrades to "works from where you
 * are" rather than to a link that goes nowhere.
 */
function absolute(url: string): string {
  return /^https?:\/\//.test(url) ? url : `${window.location.origin}${url}`;
}

export function People({ tab, tabTitle, role, meLabel, ownerEmail, here, onInvite, onRemove, onMintLink, onCloseLink }: PeopleProps) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const isOwner = role === "owner";

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel people">
      <header className="panel-head">
        <div>
          <h2>{tabTitle}</h2>
          <p className="dim">{isOwner ? "who is in this terminal" : `${ownerEmail}'s machine`}</p>
        </div>
      </header>

      <section>
        <div className="section-head">
          <h3>
            Here now <span className="dim">— across the machine</span>
          </h3>
        </div>
        <ul className="rows">
          {here.map((p) => (
            <li className="row" key={p.label}>
              <span className="dot busy" />
              <span className="row-label">{p.label === meLabel ? `${p.label} (you)` : p.label}</span>
              <span className="dim">{p.role}</span>
            </li>
          ))}
          {here.length === 0 && <li className="fine">nobody else right now</li>}
        </ul>
      </section>

      {!tab ? (
        <p className="fine">…</p>
      ) : isOwner ? (
        <>
          <section>
            <div className="section-head">
              <h3>
                Invite to {tabTitle} <span className="dim">— by email</span>
              </h3>
              <p className="fine">
                They sign in with Fountain and find this terminal waiting. Turns run on your account, so you pay for what they
                do here.
              </p>
            </div>
            <ul className="rows">
              {tab.members.map((m) => (
                <li className="row" key={m.email}>
                  <span className="row-label">{m.email}</span>
                  <button className="ghost" onClick={() => void run(() => onRemove(m.email))} disabled={busy}>
                    remove
                  </button>
                </li>
              ))}
              {tab.members.length === 0 && <li className="fine">nobody yet</li>}
            </ul>
            <div className="editor-row">
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" spellCheck={false} />
              <button
                onClick={() =>
                  void run(async () => {
                    await onInvite(email.trim());
                    setEmail("");
                  })
                }
                disabled={busy || !email.trim()}
              >
                invite
              </button>
            </div>
          </section>

          <section>
            <div className="section-head">
              <h3>
                Invite to {tabTitle} <span className="dim">— by link, no account needed</span>
              </h3>
              <p className="fine">Anyone who opens it lands in this terminal, with no sign-in at all. You pay for what they do.</p>
            </div>

            <p className="note warn">
              <strong>They get a shell on this machine.</strong> It is one terminal — they cannot see your other ones or open
              another — but a terminal is still a way to ask the agent to read the disk, including your environment secrets. If
              something must stay private while somebody is in here, keep it as a <strong>vault</strong> secret: those never
              touch the box.
            </p>

            {tab.inviteUrl ? (
              <>
                <div className="editor-row">
                  <input value={absolute(tab.inviteUrl)} readOnly spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
                  <button
                    onClick={() => {
                      void navigator.clipboard?.writeText(absolute(tab.inviteUrl!)).then(
                        () => {
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 1500);
                        },
                        () => undefined,
                      );
                    }}
                  >
                    {copied ? "copied" : "copy"}
                  </button>
                </div>
                <div className="editor-row">
                  <button className="ghost" onClick={() => void run(onMintLink)} disabled={busy}>
                    new link
                  </button>
                  <button className="ghost" onClick={() => void run(onCloseLink)} disabled={busy}>
                    close the link
                  </button>
                  <span className="fine">Either evicts whoever came in on the old one — from this terminal only.</span>
                </div>
              </>
            ) : (
              <div className="editor-row">
                <button onClick={() => void run(onMintLink)} disabled={busy}>
                  make a link
                </button>
                <span className="fine">No link for this terminal, so nobody can join it anonymously.</span>
              </div>
            )}

            {tab.guests.length > 0 && (
              <>
                <h4>Guests in {tabTitle}</h4>
                <div className="chips">
                  {tab.guests.map((g) => (
                    <span className="chip" key={g.handle}>
                      {g.handle}
                    </span>
                  ))}
                </div>
                <p className="fine">The link is the credential, so a new link is how you remove one.</p>
              </>
            )}
          </section>
        </>
      ) : (
        <section>
          <p className="fine">
            You are {role === "member" ? "a member of" : "a guest in"} {tabTitle} on {ownerEmail}'s machine. You can use this
            terminal and read the files it can see. The machine's other terminals, and what is installed on it, are not yours to
            change.
          </p>
        </section>
      )}
    </div>
  );
}
