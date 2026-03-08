import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = path.resolve(process.cwd(), "scripts", "cleanup-staff.mjs");

function createDb(): { dbPath: string; db: DatabaseSync } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-cleanup-staff-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "claw-empire.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'senior',
      cli_provider TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      stats_tasks_done INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { dbPath, db };
}

function runScript(args: string[], env: Record<string, string | undefined>) {
  return execFileSync("node", [scriptPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "pipe",
    timeout: 15000,
  }).toString();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cleanup-staff script", () => {
  it("dry-run reset은 break 상태를 실제로 바꾸지 않는다", () => {
    const { dbPath, db } = createDb();
    try {
      db.prepare("INSERT INTO agents (id, name, role, cli_provider, status) VALUES (?, ?, ?, ?, ?)").run(
        "agent-1",
        "Agent One",
        "senior",
        "codex",
        "break",
      );
      db.close();

      const output = runScript(["--reset-break", "--dry-run"], { DB_PATH: dbPath });
      const checkDb = new DatabaseSync(dbPath);
      const row = checkDb.prepare("SELECT status FROM agents WHERE id = ?").get("agent-1") as { status: string };
      checkDb.close();

      expect(output).toContain("dry-run");
      expect(row.status).toBe("break");
    } finally {
      try {
        db.close();
      } catch {
        // already closed in test body
      }
    }
  });

  it("reset과 중복/역할 리포트를 실행할 수 있다", () => {
    const { dbPath, db } = createDb();
    try {
      const insert = db.prepare(
        "INSERT INTO agents (id, name, role, cli_provider, status, stats_tasks_done) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run("core-1", "Nova", "team_leader", "codex", "break", 7);
      insert.run("core-2", "Nova", "senior", "claude", "idle", 4);
      insert.run("video_preprod-seed-1", "Nova", "junior", "gemini", "idle", 2);
      db.close();

      const output = runScript(["--all"], { DB_PATH: dbPath });
      const checkDb = new DatabaseSync(dbPath);
      const row = checkDb.prepare("SELECT status FROM agents WHERE id = ?").get("core-1") as { status: string };
      checkDb.close();

      expect(output).toContain("Role composition");
      expect(output).toContain("Duplicate agent names");
      expect(output).toContain("Nova");
      expect(row.status).toBe("idle");
    } finally {
      try {
        db.close();
      } catch {
        // already closed in test body
      }
    }
  });
});
