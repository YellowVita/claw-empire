import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  listTaskExecutionEventsForTask,
  recordTaskExecutionEvent,
  summarizeTaskExecutionEvents,
} from "./task-execution-events.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE task_execution_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      attempt_count INTEGER,
      hook_source TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_retry_queue (
      task_id TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL,
      last_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe("task execution events helpers", () => {
  it("event를 기록하고 최신순으로 조회한다", () => {
    const db = setupDb();
    try {
      recordTaskExecutionEvent(db as any, {
        taskId: "task-1",
        category: "retry",
        action: "queued",
        status: "warning",
        message: "queued",
        attemptCount: 1,
        details: { reason: "idle_timeout" },
        createdAt: 100,
      });
      recordTaskExecutionEvent(db as any, {
        taskId: "task-1",
        category: "hook",
        action: "success",
        status: "success",
        message: "hook done",
        hookSource: "project",
        durationMs: 42,
        createdAt: 200,
      });

      const events = listTaskExecutionEventsForTask(db as any, "task-1", 50);
      expect(events).toHaveLength(2);
      expect(events[0]?.category).toBe("hook");
      expect(events[1]?.details?.reason).toBe("idle_timeout");
    } finally {
      db.close();
    }
  });

  it("summary가 retry/hook/pending 상태를 집계한다", () => {
    const db = setupDb();
    try {
      recordTaskExecutionEvent(db as any, {
        taskId: "task-1",
        category: "retry",
        action: "queued",
        status: "warning",
        message: "queued",
        attemptCount: 1,
        details: { reason: "hard_timeout" },
        createdAt: 100,
      });
      recordTaskExecutionEvent(db as any, {
        taskId: "task-1",
        category: "hook",
        action: "failure",
        status: "failure",
        message: "hook failed",
        hookSource: "project",
        createdAt: 150,
      });
      db.prepare(
        "INSERT INTO task_retry_queue (task_id, attempt_count, next_run_at, last_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("task-1", 1, 999, "hard_timeout", 100, 100);

      const summary = summarizeTaskExecutionEvents(db as any, "task-1");
      expect(summary).toEqual({
        retry_count: 1,
        last_retry_reason: "hard_timeout",
        pending_retry: true,
        hook_failures: 1,
        project_hook_override_used: true,
        last_event_at: 150,
      });
    } finally {
      db.close();
    }
  });
});
