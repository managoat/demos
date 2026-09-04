/**
 * Who is in this machine, and how to let somebody else in.
 *
 * The warning is the important part of this panel, not the buttons. Anyone who
 * can prompt the agent can make it read anything on the box — there is no
 * permission that prevents it, because the agent is the thing with the shell.
 * So the invite says so, in the place where somebody is deciding, rather than
 * in a README nobody opens.
 *
 * It also points at the one real mitigation, which the Machine panel already
 * draws: a vault secret is never on the box. Once other people are in here,
 * that is where anything sensitive belongs.
 */
import { useState } from "react";
import type { PaddockDto, Role } from "../api/paddock";

export interface PeopleProps {
  paddock: PaddockDto;
  role: Role;
  meLabel: string;
  onInvite: (email: string) => Promise<void>;
  onRemove: (email: string) => Promise<void>;
  onMintLink: () => Promise<void>;
  onCloseLink: () => Promise<void>;
}

/**
 * The link, as something you can actually paste.
 *
 * The server builds it from PUBLIC_URL, which is right in production and unset
 * in dev — where it would otherwise render as a bare `/#/join/…`. Resolving it
 * against the current origin here means a misconfigured PUBLIC_URL degrades to
 * "the link works from where you are" rather than to a link that goes nowhere.
 */
function absolute(url: string): string {
  return /^https?:\/\//.test(url) ? url : `${window.location.origin}${url}`;
}

export function People({ paddock, role, meLabel, onInvite, onRemove, onMintLink, onCloseLink }: PeopleProps) {
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
          <h2>People</h2>
          <p className="dim">
            {paddock.here.length} here · {isOwner ? "your machine" : `${paddock.ownerEmail}'s machine`}
          </p>
        </div>
      </header>

      <section>
        <ul className="rows">
          {paddock.here.map((p) => (
            <li className="row" key={p.label}>
              <span className="dot busy" />
              <span className="row-label">{p.label === meLabel ? `${p.label} (you)` : p.label}</span>
              <span className="dim">{p.role}</span>
            </li>
          ))}
          {paddock.here.length === 0 && <li className="fine">nobody else right now</li>}
        </ul>
      </section>

      {isOwner && (
        <>
          <section>
            <div className="section-head">
              <h3>
                Invite by email <span className="dim">— they sign in with Fountain</span>
              </h3>
              <p className="fine">They find this machine waiting. Turns run on your account, so you pay for what they do.</p>
            </div>
            <ul className="rows">
              {paddock.members.map((m) => (
                <li className="row" key={m.email}>
                  <span className="row-label">{m.email}</span>
                  <button className="ghost" onClick={() => void run(() => onRemove(m.email))} disabled={busy}>
                    remove
                  </button>
                </li>
              ))}
              {paddock.members.length === 0 && <li className="fine">nobody yet</li>}
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
                Invite by link <span className="dim">— no account needed</span>
              </h3>
              <p className="fine">Anyone who opens it is in, with no sign-in at all. You pay for everything they do.</p>
            </div>

            <p className="note warn">
              <strong>A guest can read this machine.</strong> Anyone who can type into a tab can ask the agent to print your
              environment secrets, your repositories, anything on the disk. No setting here prevents that. If something must
              stay private while other people are in, keep it as a <strong>vault</strong> secret — those never touch the box.
            </p>

            {paddock.inviteUrl ? (
              <>
                <div className="editor-row">
                  <input value={absolute(paddock.inviteUrl)} readOnly spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
                  <button
                    onClick={() => {
                      void navigator.clipboard?.writeText(absolute(paddock.inviteUrl!)).then(
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
                  <span className="fine">Either one evicts everybody who came in on the old link, mid-session.</span>
                </div>
              </>
            ) : (
              <div className="editor-row">
                <button onClick={() => void run(onMintLink)} disabled={busy}>
                  make a link
                </button>
                <span className="fine">No link right now, so nobody can join anonymously.</span>
              </div>
            )}

            {paddock.guests.length > 0 && (
              <>
                <h4>Guests on the link</h4>
                <div className="chips">
                  {paddock.guests.map((g) => (
                    <span className="chip" key={g.handle}>
                      {g.handle}
                    </span>
                  ))}
                </div>
                <p className="fine">Removing one individually is not a thing — the link is the credential, so a new link is the revoke.</p>
              </>
            )}
          </section>
        </>
      )}

      {!isOwner && (
        <section>
          <p className="fine">
            You are {role === "member" ? "a member of" : "a guest on"} this machine. You can use its terminals and read its
            files; only {paddock.ownerEmail} can change what is installed on it.
          </p>
        </section>
      )}
    </div>
  );
}
