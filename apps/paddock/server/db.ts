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
  handle: string;
  created_at: string;
  seen_at: string;
}

export interface PaddockRow {
  id: string;
  owner_email: string;
  /** The current join link's token; re-minting invalidates the previous one. */
  invite_token: string | null;
  created_at: string;
}

export interface MemberRow {
  paddock_id: string;
  email: string;
  added_at: string;
  added_by: string;
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email             TEXT PRIMARY KEY,
  fountain_user_id  TEXT,
  key_enc           TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paddocks (
  id           TEXT PRIMARY KEY,
  owner_email  TEXT NOT NULL REFERENCES users(email),
  invite_token TEXT UNIQUE,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS paddocks_owner ON paddocks(owner_email);

CREATE TABLE IF NOT EXISTS paddock_members (
  paddock_id TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  added_at   TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  PRIMARY KEY (paddock_id, email)
);

CREATE TABLE IF NOT EXISTS paddock_guests (
  id         TEXT PRIMARY KEY,
  paddock_id TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE,
  handle     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seen_at    TEXT NOT NULL
);

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

  /** One paddock per owner: the machine is the account's, so the row is too. */
  ensurePaddock(id: string, ownerEmail: string): PaddockRow {
    const existing = this.paddockOf(ownerEmail);
    if (existing) return existing;
    this.sql.query("INSERT INTO paddocks (id, owner_email, invite_token, created_at) VALUES ($id, $o, NULL, $at)").run({ id, o: ownerEmail, at: now() });
    return this.getPaddock(id)!;
  }

  getPaddock(id: string): PaddockRow | null {
    return this.sql.query("SELECT * FROM paddocks WHERE id = $id").get({ id }) as PaddockRow | null;
  }

  paddockOf(ownerEmail: string): PaddockRow | null {
    return this.sql.query("SELECT * FROM paddocks WHERE owner_email = $o").get({ o: ownerEmail }) as PaddockRow | null;
  }

  paddockByInvite(token: string): PaddockRow | null {
    if (!token) return null;
    return this.sql.query("SELECT * FROM paddocks WHERE invite_token = $t").get({ t: token }) as PaddockRow | null;
  }

  setInviteToken(id: string, token: string | null): void {
    this.sql.query("UPDATE paddocks SET invite_token = $t WHERE id = $id").run({ id, t: token });
  }

  // ── members and guests ──────────────────────────────────────────────────

  addMember(paddockId: string, email: string, addedBy: string): void {
    this.sql
      .query("INSERT INTO paddock_members (paddock_id, email, added_at, added_by) VALUES ($p, $e, $at, $by) ON CONFLICT DO NOTHING")
      .run({ p: paddockId, e: email, at: now(), by: addedBy });
  }

  removeMember(paddockId: string, email: string): void {
    this.sql.query("DELETE FROM paddock_members WHERE paddock_id = $p AND email = $e").run({ p: paddockId, e: email });
  }

  members(paddockId: string): MemberRow[] {
    return this.sql.query("SELECT * FROM paddock_members WHERE paddock_id = $p ORDER BY added_at").all({ p: paddockId }) as MemberRow[];
  }

  isMember(paddockId: string, email: string): boolean {
    return !!this.sql.query("SELECT 1 FROM paddock_members WHERE paddock_id = $p AND email = $e").get({ p: paddockId, e: email });
  }

  createGuest(id: string, paddockId: string, handle: string): GuestRow {
    const at = now();
    this.sql.query("INSERT INTO paddock_guests (id, paddock_id, handle, created_at, seen_at) VALUES ($id, $p, $h, $at, $at)").run({ id, p: paddockId, h: handle, at });
    return this.getGuest(id)!;
  }

  getGuest(id: string): GuestRow | null {
    return this.sql.query("SELECT * FROM paddock_guests WHERE id = $id").get({ id }) as GuestRow | null;
  }

  touchGuest(id: string): void {
    this.sql.query("UPDATE paddock_guests SET seen_at = $at WHERE id = $id").run({ id, at: now() });
  }

  guests(paddockId: string): GuestRow[] {
    return this.sql.query("SELECT * FROM paddock_guests WHERE paddock_id = $p ORDER BY created_at").all({ p: paddockId }) as GuestRow[];
  }

  /**
   * Re-minting a link locks out everyone who joined through the old one:
   * their sessions go with it. This is the whole revocation story for
   * anonymous guests, so it has to be complete rather than cosmetic.
   */
  revokeGuests(paddockId: string): number {
    // Counted before the delete rather than read off `changes`: the sessions
    // that cascade away are counted there too, and "2 guests evicted" when one
    // person left is the kind of wrong number people make decisions on.
    const evicted = this.guests(paddockId).length;
    this.sql.query("DELETE FROM paddock_guests WHERE paddock_id = $paddockId").run({ paddockId });
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
