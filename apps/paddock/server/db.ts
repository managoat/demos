/**
 * Paddock's own record: who has signed in, whose machine is shared with
 * whom, and who is holding or waiting for the box.
 *
 * What is deliberately *not* here: anything Fountain already knows. The
 * machine, its tabs, what is installed on it and which tabs are behind are
 * all still derived from Fountain and from the box itself, exactly as they
 * were in phase 1 — this database holds only the things Fountain has no
 * opinion about, which are people and permission.
 *
 * Modelled on `apps/salon/server/db.ts`, with one deliberate difference: an
 * anonymous guest is a first-class row rather than a user with a blank
 * email, so no query can accidentally treat one as a member. See `context.ts`.
 */
import { Database } from "bun:sqlite";

export type Role = "owner" | "member" | "guest";

export interface UserRow {
  email: string;
  fountain_user_id: string | null;
  /** The Fountain key, encrypted. Guests never have one. */
  key_enc: string;
  created_at: string;
}

export interface GuestRow {
  id: string;
  paddock_id: string;
  /** The one tab this guest was invited to. They can reach no other. */
  conversation_id: string;
  handle: string;
  created_at: string;
  seen_at: string;
}

export interface PaddockRow {
  id: string;
  owner_email: string;
  /** What the owner calls this computer. Theirs to change; never empty. */
  name: string;
  created_at: string;
}

export interface MemberRow {
  paddock_id: string;
  /** The tab they were invited to. Membership is per-tab, not per-machine. */
  conversation_id: string;
  email: string;
  added_at: string;
  added_by: string;
}

/** One live join link, for one tab. Re-minting replaces it. */
export interface InviteRow {
  token: string;
  paddock_id: string;
  conversation_id: string;
  created_at: string;
}

/** A session belongs to exactly one of a user or a guest — never both, never neither. */
export interface SessionRow {
  token_hash: string;
  email: string | null;
  guest_id: string | null;
  created_at: string;
}

export function now(): string {
  return new Date().toISOString();
}

/** What an account's first computer is called before anybody renames it. */
export const FIRST_NAME = "My computer";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email             TEXT PRIMARY KEY,
  fountain_user_id  TEXT,
  key_enc           TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

-- An account owns as many computers as it asks for. It used to own exactly
-- one, enforced by a unique index here; migrate() drops that index rather than
-- the table, because this row is what every membership, invitation and guest
-- points at.
CREATE TABLE IF NOT EXISTS paddocks (
  id           TEXT PRIMARY KEY,
  owner_email  TEXT NOT NULL REFERENCES users(email),
  name         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paddocks_by_owner ON paddocks(owner_email, created_at);

-- Membership is of a *tab*, not of the machine. Somebody invited to Terminal 2
-- sees Terminal 2; the rest of the box is not theirs to look at. The original
-- brief said "people invited to a thread" and meant it.
CREATE TABLE IF NOT EXISTS paddock_members (
  paddock_id      TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  email           TEXT NOT NULL,
  added_at        TEXT NOT NULL,
  added_by        TEXT NOT NULL,
  PRIMARY KEY (paddock_id, conversation_id, email)
);

CREATE TABLE IF NOT EXISTS paddock_guests (
  id              TEXT PRIMARY KEY,
  paddock_id      TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  handle          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  seen_at         TEXT NOT NULL
);

-- One live link per tab. Minting again for the same tab replaces the row, so
-- the previous link stops working — which is the whole revocation story.
CREATE TABLE IF NOT EXISTS tab_invites (
  token           TEXT PRIMARY KEY,
  paddock_id      TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tab_invites_tab ON tab_invites(paddock_id, conversation_id);

-- Exactly one of email / guest_id is set. SQLite cannot express "exactly one"
-- as a foreign key, so it is a CHECK, and context.ts reads the pair as a
-- discriminated union rather than trusting either column alone.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT REFERENCES users(email),
  -- No foreign key, deliberately. When a re-mint deletes the guest rows, their
  -- sessions have to *survive* the delete so the next request can look up a
  -- guest_id that no longer resolves and say "that link was replaced" rather
  -- than the misleading "your session ended". A cascade would take the row and
  -- the explanation with it; an enforced FK would refuse the delete outright.
  -- The orphans are harmless and expireSessions sweeps them.
  guest_id   TEXT,
  created_at TEXT NOT NULL,
  CHECK ((email IS NULL) <> (guest_id IS NULL))
);

-- Who opened a tab. The channel_id stays exactly as shared/tabs.ts parses it;
-- this is the one extra fact, kept here rather than encoded into a format the
-- client and server both have to agree on.
CREATE TABLE IF NOT EXISTS tab_openers (
  conversation_id TEXT PRIMARY KEY,
  paddock_id      TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE,
  actor           TEXT NOT NULL,
  opened_at       TEXT NOT NULL
);
`;

export class Db {
  readonly sql: Database;

  constructor(path: string) {
    // `strict: true` is what makes bare parameter names bind to `$name`
    // placeholders. Without it every named parameter silently binds NULL,
    // which a nullable column would have accepted in silence. Same flag as
    // salon and fountain-workbench.
    this.sql = new Database(path, { create: true, strict: true });
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Two changes of shape, handled differently on purpose.
   *
   * Invitations became per-tab, and there is no honest way to convert the old
   * rows: somebody invited to "the machine" was not invited to any particular
   * tab, and guessing one would hand them a terminal nobody chose. So the two
   * tables are rebuilt rather than altered, and the invitations are lost.
   *
   * That is a real, if small, loss, and it is the right one: the alternative
   * is silently widening or narrowing an access grant somebody made. Anyone
   * affected is re-invited in a click.
   *
   * A paddock became one computer of several rather than *the* computer, which
   * is the opposite kind of change: nothing about an existing row became
   * wrong, only the unique index saying there could be no second one. So the
   * index goes and every row stays exactly where it is. Dropping one here
   * would take somebody's machine away, which is the thing this app exists not
   * to do.
   */
  private migrate(): void {
    for (const table of ["paddock_members", "paddock_guests"]) {
      const columns = this.sql.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (columns.length && !columns.some((c) => c.name === "conversation_id")) {
        this.sql.exec(`DROP TABLE ${table}`);
      }
    }

    const paddockColumns = this.sql.query("PRAGMA table_info(paddocks)").all() as { name: string }[];
    if (paddockColumns.length && !paddockColumns.some((c) => c.name === "name")) {
      this.sql.exec("ALTER TABLE paddocks ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    }
    this.sql.exec("DROP INDEX IF EXISTS paddocks_owner");

    this.sql.exec(SCHEMA);
    // A row from before computers had names is somebody's only machine, so it
    // gets the name a first machine is given.
    this.sql.query("UPDATE paddocks SET name = $name WHERE name = ''").run({ name: FIRST_NAME });
  }

  // ── users ───────────────────────────────────────────────────────────────

  upsertUser(email: string, fountainUserId: string | null, keyEnc: string): void {
    this.sql
      .query(
        `INSERT INTO users (email, fountain_user_id, key_enc, created_at) VALUES ($email, $fid, $key, $at)
         ON CONFLICT(email) DO UPDATE SET fountain_user_id = $fid, key_enc = $key`,
      )
      .run({ email, fid: fountainUserId, key: keyEnc, at: now() });
  }

  getUser(email: string): UserRow | null {
    return this.sql.query("SELECT * FROM users WHERE email = $email").get({ email }) as UserRow | null;
  }

  // ── sessions ────────────────────────────────────────────────────────────

  createUserSession(tokenHash: string, email: string): void {
    this.sql.query("INSERT INTO sessions (token_hash, email, guest_id, created_at) VALUES ($t, $e, NULL, $at)").run({ t: tokenHash, e: email, at: now() });
  }

  createGuestSession(tokenHash: string, guestId: string): void {
    this.sql.query("INSERT INTO sessions (token_hash, email, guest_id, created_at) VALUES ($t, NULL, $g, $at)").run({ t: tokenHash, g: guestId, at: now() });
  }

  session(tokenHash: string): SessionRow | null {
    return this.sql.query("SELECT * FROM sessions WHERE token_hash = $t").get({ t: tokenHash }) as SessionRow | null;
  }

  deleteSession(tokenHash: string): void {
    this.sql.query("DELETE FROM sessions WHERE token_hash = $t").run({ t: tokenHash });
  }

  expireSessions(maxAgeMs: number): void {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    this.sql.query("DELETE FROM sessions WHERE created_at < $cutoff").run({ cutoff });
  }

  // ── paddocks ────────────────────────────────────────────────────────────

  /**
   * The account's first computer, made if it has none.
   *
   * Everybody who can sign in is entitled to one and the row costs nothing
   * until somebody opens it. Every computer after the first is asked for —
   * `createPaddock` — because a second machine is a decision and a first one
   * is not.
   */
  ensurePaddock(id: string, ownerEmail: string): PaddockRow {
    return this.paddocksOf(ownerEmail)[0] ?? this.createPaddock(id, ownerEmail, FIRST_NAME);
  }

  createPaddock(id: string, ownerEmail: string, name: string): PaddockRow {
    this.sql
      .query("INSERT INTO paddocks (id, owner_email, name, created_at) VALUES ($id, $o, $n, $at)")
      .run({ id, o: ownerEmail, n: name, at: now() });
    return this.getPaddock(id)!;
  }

  getPaddock(id: string): PaddockRow | null {
    return this.sql.query("SELECT * FROM paddocks WHERE id = $id").get({ id }) as PaddockRow | null;
  }

  /**
   * Every computer this account owns, oldest first.
   *
   * The order is load-bearing rather than cosmetic: the first row is the
   * *original* machine, and it is the only one that may claim a tab whose
   * channel names no computer (`tabs.belongsTo`).
   *
   * `rowid` breaks the tie, and it has to be something monotonic rather than
   * anything about the row. Signing in and immediately adding a computer puts
   * both inserts in the same millisecond often enough to see it, and with the
   * id as the tiebreak — a random token — the *new* machine sorted first
   * roughly half the time and adopted the old one's tabs. Insert order is the
   * question being asked, so insert order is what is sorted on.
   */
  paddocksOf(ownerEmail: string): PaddockRow[] {
    return this.sql.query("SELECT * FROM paddocks WHERE owner_email = $o ORDER BY created_at, rowid").all({ o: ownerEmail }) as PaddockRow[];
  }

  renamePaddock(id: string, name: string): void {
    this.sql.query("UPDATE paddocks SET name = $n WHERE id = $id").run({ id, n: name });
  }

  /**
   * Forget a computer. Its members, guests, links and tab openers go with it
   * through `ON DELETE CASCADE`; what happens to the machine on Fountain is
   * `lifecycle.ts`'s business and has already happened by the time this runs.
   */
  deletePaddock(id: string): void {
    this.sql.query("DELETE FROM paddocks WHERE id = $id").run({ id });
  }

  /** The tab a link opens, or null when the link is dead. */
  invite(token: string): InviteRow | null {
    if (!token) return null;
    return this.sql.query("SELECT * FROM tab_invites WHERE token = $t").get({ t: token }) as InviteRow | null;
  }

  inviteFor(paddockId: string, conversationId: string): InviteRow | null {
    return this.sql
      .query("SELECT * FROM tab_invites WHERE paddock_id = $p AND conversation_id = $c")
      .get({ p: paddockId, c: conversationId }) as InviteRow | null;
  }

  /** Mint the link for one tab, replacing whatever it had. */
  setInvite(paddockId: string, conversationId: string, token: string): void {
    this.sql.query("DELETE FROM tab_invites WHERE paddock_id = $p AND conversation_id = $c").run({ p: paddockId, c: conversationId });
    this.sql
      .query("INSERT INTO tab_invites (token, paddock_id, conversation_id, created_at) VALUES ($t, $p, $c, $at)")
      .run({ t: token, p: paddockId, c: conversationId, at: now() });
  }

  clearInvite(paddockId: string, conversationId: string): void {
    this.sql.query("DELETE FROM tab_invites WHERE paddock_id = $p AND conversation_id = $c").run({ p: paddockId, c: conversationId });
  }

  /**
   * Every paddock this person can reach: the computers they own, oldest first,
   * then any whose tab they were invited to.
   *
   * `original` marks the first machine they ever had, and it travels with the
   * row because both sides need it and neither should work it out again: the
   * server uses it to decide which computer an un-named tab is on, the browser
   * to decide which computer an un-marked Fountain agent belongs to. Two
   * answers to that question is one too many.
   */
  paddocksFor(email: string): { id: string; name: string; ownerEmail: string; role: Role; original: boolean }[] {
    const own = this.paddocksOf(email);
    const shared = this.sql
      .query(
        `SELECT DISTINCT p.id AS id, p.name AS name, p.owner_email AS owner_email
           FROM paddock_members m JOIN paddocks p ON p.id = m.paddock_id
          WHERE m.email = $e AND p.owner_email != $e
          ORDER BY p.created_at`,
      )
      .all({ e: email }) as { id: string; name: string; owner_email: string }[];
    return [
      ...own.map((p, i) => ({ id: p.id, name: p.name, ownerEmail: p.owner_email, role: "owner" as Role, original: i === 0 })),
      ...shared.map((r) => ({ id: r.id, name: r.name, ownerEmail: r.owner_email, role: "member" as Role, original: false })),
    ];
  }

  // ── members and guests ──────────────────────────────────────────────────

  addMember(paddockId: string, conversationId: string, email: string, addedBy: string): void {
    this.sql
      .query(
        "INSERT INTO paddock_members (paddock_id, conversation_id, email, added_at, added_by) VALUES ($p, $c, $e, $at, $by) ON CONFLICT DO NOTHING",
      )
      .run({ p: paddockId, c: conversationId, e: email, at: now(), by: addedBy });
  }

  removeMember(paddockId: string, conversationId: string, email: string): void {
    this.sql
      .query("DELETE FROM paddock_members WHERE paddock_id = $p AND conversation_id = $c AND email = $e")
      .run({ p: paddockId, c: conversationId, e: email });
  }

  /** Everybody invited to one tab. */
  members(paddockId: string, conversationId: string): MemberRow[] {
    return this.sql
      .query("SELECT * FROM paddock_members WHERE paddock_id = $p AND conversation_id = $c ORDER BY added_at")
      .all({ p: paddockId, c: conversationId }) as MemberRow[];
  }

  /** Everybody invited to anything on this machine — for counting, not for access. */
  allMembers(paddockId: string): MemberRow[] {
    return this.sql.query("SELECT * FROM paddock_members WHERE paddock_id = $p ORDER BY added_at").all({ p: paddockId }) as MemberRow[];
  }

  /** The tabs this person was invited to. Empty means they are not in the paddock. */
  memberTabs(paddockId: string, email: string): string[] {
    const rows = this.sql
      .query("SELECT conversation_id FROM paddock_members WHERE paddock_id = $p AND email = $e ORDER BY added_at")
      .all({ p: paddockId, e: email }) as { conversation_id: string }[];
    return rows.map((r) => r.conversation_id);
  }

  createGuest(id: string, paddockId: string, conversationId: string, handle: string): GuestRow {
    const at = now();
    this.sql
      .query("INSERT INTO paddock_guests (id, paddock_id, conversation_id, handle, created_at, seen_at) VALUES ($id, $p, $c, $h, $at, $at)")
      .run({ id, p: paddockId, c: conversationId, h: handle, at });
    return this.getGuest(id)!;
  }

  getGuest(id: string): GuestRow | null {
    return this.sql.query("SELECT * FROM paddock_guests WHERE id = $id").get({ id }) as GuestRow | null;
  }

  deleteGuest(id: string): void {
    this.sql.query("DELETE FROM paddock_guests WHERE id = $id").run({ id });
  }

  touchGuest(id: string): void {
    this.sql.query("UPDATE paddock_guests SET seen_at = $at WHERE id = $id").run({ id, at: now() });
  }

  /** Guests on one tab. */
  guests(paddockId: string, conversationId: string): GuestRow[] {
    return this.sql
      .query("SELECT * FROM paddock_guests WHERE paddock_id = $p AND conversation_id = $c ORDER BY created_at")
      .all({ p: paddockId, c: conversationId }) as GuestRow[];
  }

  /** Every guest on the machine — for counting, not for access. */
  allGuests(paddockId: string): GuestRow[] {
    return this.sql.query("SELECT * FROM paddock_guests WHERE paddock_id = $p ORDER BY created_at").all({ p: paddockId }) as GuestRow[];
  }

  /**
   * Re-minting a link locks out everyone who joined through the old one:
   * their sessions go with it. This is the whole revocation story for
   * anonymous guests, so it has to be complete rather than cosmetic.
   */
  /** Evict the guests of one tab. Counted before the delete — see below. */
  revokeGuests(paddockId: string, conversationId: string): number {
    // Counted rather than read off `changes`: the sessions that cascade away
    // are counted there too, and "2 guests evicted" when one person left is
    // the kind of wrong number people make decisions on.
    const evicted = this.guests(paddockId, conversationId).length;
    this.sql.query("DELETE FROM paddock_guests WHERE paddock_id = $p AND conversation_id = $c").run({ p: paddockId, c: conversationId });
    return evicted;
  }

  /** Everybody off the machine: a reset, or a tab-by-tab teardown. */
  revokeAllGuests(paddockId: string): number {
    const evicted = this.allGuests(paddockId).length;
    this.sql.query("DELETE FROM paddock_guests WHERE paddock_id = $paddockId").run({ paddockId });
    this.sql.query("DELETE FROM tab_invites WHERE paddock_id = $paddockId").run({ paddockId });
    return evicted;
  }

  // ── tabs ────────────────────────────────────────────────────────────────

  recordTabOpener(conversationId: string, paddockId: string, actor: string): void {
    this.sql
      .query("INSERT INTO tab_openers (conversation_id, paddock_id, actor, opened_at) VALUES ($c, $p, $a, $at) ON CONFLICT DO NOTHING")
      .run({ c: conversationId, p: paddockId, a: actor, at: now() });
  }

  tabOpeners(paddockId: string): Record<string, string> {
    const rows = this.sql.query("SELECT conversation_id, actor FROM tab_openers WHERE paddock_id = $p").all({ p: paddockId }) as {
      conversation_id: string;
      actor: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.conversation_id, r.actor]));
  }
}
