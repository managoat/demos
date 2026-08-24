import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, now } from "./db";

// The database is a file on a volume that outlives the image, so a schema
// change meets tables that already exist. `CREATE TABLE IF NOT EXISTS` does
// nothing to those; Db.migrate is what carries them forward.

const paths: string[] = [];

function tempPath(name: string): string {
  const p = join(tmpdir(), `wb-${name}-${Bun.randomUUIDv7()}.sqlite`);
  paths.push(p);
  return p;
}

afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

describe("opening a database written by an older build", () => {
  test("a projects table with no default_agent_id gets one, and its rows survive", () => {
    const path = tempPath("old");
    const old = new Database(path, { create: true, strict: true });
    old.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      name TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      environment_id TEXT,
      vault_id TEXT,
      created_at TEXT NOT NULL
    )`);
    old.query("INSERT INTO projects (id, owner_email, name, notes, environment_id, vault_id, created_at) VALUES ('p1', 'a@b.c', 'Fountain', '', 'e1', 'v1', $t)").run({ t: now() });
    old.close();

    const db = new Db(path);
    const p = db.getProject("p1")!;
    expect(p.name).toBe("Fountain");
    expect(p.environment_id).toBe("e1");
    // The column is there and empty: an existing project asks every time until someone picks.
    expect(p.default_agent_id).toBeNull();

    db.updateProject("p1", { default_agent_id: "a1" });
    expect(db.getProject("p1")!.default_agent_id).toBe("a1");
    db.close();
  });

  test("opening twice does not trip over the column it added", () => {
    const path = tempPath("twice");
    new Db(path).close();
    const db = new Db(path);
    expect(db.getProject("nope")).toBeNull();
    db.close();
  });
});
