import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { listPendingDelegationParentTaskIds } from "./task-queries.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT,
      updated_at INTEGER,
      orchestration_version INTEGER,
      orchestration_stage TEXT
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      status TEXT,
      target_department_id TEXT,
      delegated_task_id TEXT,
      orchestration_phase TEXT
    );
  `);
  return db;
}

describe("listPendingDelegationParentTaskIds", () => {
  it("includes V2 review tasks that still need owner integration", () => {
    const db = createDb();
    try {
      db.prepare(
        "INSERT INTO tasks (id, status, updated_at, orchestration_version, orchestration_stage) VALUES (?, ?, ?, ?, ?)",
      ).run("task-review-owner-integrate", "review", 10, 2, "review");
      db.prepare(
        "INSERT INTO subtasks (id, task_id, status, target_department_id, delegated_task_id, orchestration_phase) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("sub-owner-integrate", "task-review-owner-integrate", "pending", null, null, "owner_integrate");

      db.prepare(
        "INSERT INTO tasks (id, status, updated_at, orchestration_version, orchestration_stage) VALUES (?, ?, ?, ?, ?)",
      ).run("task-review-clean", "review", 20, 2, "review");
      db.prepare(
        "INSERT INTO subtasks (id, task_id, status, target_department_id, delegated_task_id, orchestration_phase) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("sub-owner-prep", "task-review-clean", "pending", null, null, "owner_prep");

      expect(listPendingDelegationParentTaskIds(db)).toContain("task-review-owner-integrate");
      expect(listPendingDelegationParentTaskIds(db)).not.toContain("task-review-clean");
    } finally {
      db.close();
    }
  });
});
