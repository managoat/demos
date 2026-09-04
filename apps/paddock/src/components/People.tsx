/**
 * Who is in *this tab*, and how to let somebody else into it.
 *
 * Invitations name a terminal, not the machine. Somebody let into Terminal 2
 * sees Terminal 2: not the other terminals, not what is on the rest of the
 * disk through them, and they cannot open a third. That is what the original
 * brief asked for — people invited to a thread — and it is a much smaller
 * thing to hand out than a whole computer.
 *
 * The panel is two doors and a guest list, so it is laid out as two doors and
 * a guest list. Each door is a card that names itself in two words, puts its
 * control on the next line, and only then explains itself; the tab's title is
 * said once, in the header, instead of inside three headings that a generated
 * title then wraps to three lines.
 *
 * The warning is still the important part of the link card, because the
 * reduction is real but partial: a tab is a shell on the machine, so anyone
 * who can type into one can still ask the agent to read the disk. Its first
 * sentence is always on screen; the rest of the explanation is a disclosure,
 * because a wall of caveat above a button is how the button got lost.
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
        <div className="head-copy">
          <h2>People</h2>
          <p className="dim clip" title={tabTitle}>
            {isOwner ? <>in {tabTitle}</> : <>in {tabTitle}, on {ownerEmail}'s machine</>}
          </p>
        </div>
      </header>

      <section>
        <h4 className="loud">
          Here now <span className="dim">· across the machine</span>
        </h4>
        <ul className="who">
          {here.map((p, i) => (
            <li key={`${p.label}-${i}`}>
              <span className="who-dot" />
              <span className="who-name clip" title={p.label}>
                {p.label}
              </span>
              {p.label === meLabel && <span className="badge">you</span>}
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
          <section className="act">
            <div className="act-head">
              <h3>Invite by email</h3>
              <span className="badge">they sign in</span>
            </div>
            <div className="act-do">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="someone@example.com"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || busy || !email.trim()) return;
                  void run(async () => {
                    await onInvite(email.trim());
                    setEmail("");
                  });
                }}
              />
              <button
                className="primary"
                onClick={() =>
                  void run(async () => {
                    await onInvite(email.trim());
                    setEmail("");
                  })
                }
                disabled={busy || !email.trim()}
              >
                Invite
              </button>
            </div>
            <p className="fine">They sign in with Fountain and find this terminal waiting. Their turns run on your account.</p>
            <ul className="rows act-list">
              {tab.members.map((m) => (
                <li className="row" key={m.email}>
                  <span className="row-label clip" title={m.email}>
                    {m.email}
                  </span>
                  <span className="spacer" />
                  <button className="ghost danger-text" onClick={() => void run(() => onRemove(m.email))} disabled={busy}>
                    remove
                  </button>
                </li>
              ))}
              {tab.members.length === 0 && <li className="fine">nobody invited by email yet</li>}
            </ul>
          </section>

          <section className="act">
            <div className="act-head">
              <h3>Invite by link</h3>
              <span className="badge">no account needed</span>
            </div>

            {tab.inviteUrl ? (
              <>
                <div className="act-do">
                  <input value={absolute(tab.inviteUrl)} readOnly spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
                  <button
                    className="primary"
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
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="fine">The link is live. Anyone who opens it lands in this terminal with no sign-in, on your account.</p>
              </>
            ) : (
              <>
                <div className="act-do">
                  <button className="primary wide" onClick={() => void run(onMintLink)} disabled={busy}>
                    Make a link
                  </button>
                </div>
                <p className="fine">No link for this terminal, so nobody can join it anonymously.</p>
              </>
            )}

            <details className="caveat">
              <summary>
                <span className="glyph">⚠</span> They get a shell on this machine
              </summary>
              <p>
                It is one terminal — they cannot see your other ones or open another — but a terminal is still a way to ask the
                agent to read the disk, including your environment secrets. If something must stay private while somebody is in
                here, keep it as a <strong>vault</strong> secret: those never touch the box.
              </p>
            </details>

            {tab.inviteUrl && (
              <div className="act-more">
                <button className="ghost" onClick={() => void run(onMintLink)} disabled={busy}>
                  New link
                </button>
                <button className="ghost danger-text" onClick={() => void run(onCloseLink)} disabled={busy}>
                  Close the link
                </button>
                <span className="fine">Either evicts whoever came in on the old one, from this terminal only.</span>
              </div>
            )}

            {tab.guests.length > 0 && (
              <div className="act-list">
                <h4 className="loud">In on the link · {tab.guests.length}</h4>
                <div className="chips">
                  {tab.guests.map((g) => (
                    <span className="chip" key={g.handle}>
                      {g.handle}
                    </span>
                  ))}
                </div>
                <p className="fine">The link is the credential, so a new link is how you remove one.</p>
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="act">
          <div className="act-head">
            <h3>You are {role === "member" ? "a member here" : "a guest here"}</h3>
          </div>
          <p className="fine">
            You can use this terminal and read the files it can see. The machine's other terminals, and what is installed on it,
            belong to {ownerEmail}.
          </p>
        </section>
      )}
    </div>
  );
}
