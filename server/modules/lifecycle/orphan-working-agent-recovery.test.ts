import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { recoverOrphanWorkingAgents } from "./orphan-working-agent-recovery.ts";

function initDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL,
      current_task_id TEXT
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
  return db;
}

describe("orphan working agent recovery", () => {
  it("clears working agents whose linked task is missing", () => {
    const db = initDb();
    db.prepare("INSERT INTO agents (id, name, status, current_task_id) VALUES (?, ?, ?, ?)").run(
      "agent-1",
      "Agent One",
      "working",
      "task-missing",
    );

    const broadcast = vi.fn();
    recoverOrphanWorkingAgents({ db, broadcast }, "startup");

    const agent = db.prepare("SELECT status, current_task_id FROM agents WHERE id = ?").get("agent-1") as {
      status: string;
      current_task_id: string | null;
    };
    expect(agent.status).toBe("idle");
    expect(agent.current_task_id).toBeNull();
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it("keeps agents whose task is still in progress", () => {
    const db = initDb();
    db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("task-live", "in_progress");
    db.prepare("INSERT INTO agents (id, name, status, current_task_id) VALUES (?, ?, ?, ?)").run(
      "agent-2",
      "Agent Two",
      "working",
      "task-live",
    );

    const broadcast = vi.fn();
    recoverOrphanWorkingAgents({ db, broadcast }, "interval");

    const agent = db.prepare("SELECT status, current_task_id FROM agents WHERE id = ?").get("agent-2") as {
      status: string;
      current_task_id: string | null;
    };
    expect(agent.status).toBe("working");
    expect(agent.current_task_id).toBe("task-live");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
