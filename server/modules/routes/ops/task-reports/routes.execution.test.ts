import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { registerTaskReportRoutes } from "./routes.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      assigned_agent_id TEXT,
      status TEXT,
      project_id TEXT,
      project_path TEXT,
      result TEXT,
      source_task_id TEXT,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'senior',
      department_id TEXT
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      core_goal TEXT NOT NULL
    );
    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      kind TEXT,
      message TEXT,
      created_at INTEGER
    );
    CREATE TABLE task_quality_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      details TEXT,
      required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      evidence_markdown TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE meeting_minutes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      meeting_type TEXT,
      round INTEGER,
      title TEXT,
      status TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER
    );
    CREATE TABLE meeting_minute_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      speaker_agent_id TEXT,
      speaker_name TEXT,
      department_name TEXT,
      role_label TEXT,
      message_type TEXT,
      content TEXT,
      created_at INTEGER
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      assigned_agent_id TEXT,
      target_department_id TEXT,
      delegated_task_id TEXT,
      orchestration_phase TEXT,
      completed_at INTEGER,
      created_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      sender_id TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_type TEXT NOT NULL
    );
    CREATE TABLE task_report_archives (
      root_task_id TEXT NOT NULL,
      summary_markdown TEXT,
      updated_at INTEGER,
      created_at INTEGER,
      generated_by_agent_id TEXT
    );
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
      attempt_count INTEGER NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.prepare("INSERT INTO departments (id, name, name_ko) VALUES (?, ?, ?)").run("planning", "Planning", "기획팀");
  db.prepare("INSERT INTO agents (id, name, name_ko, role, department_id) VALUES (?, ?, ?, ?, ?)").run(
    "agent-1",
    "Ari",
    "아리",
    "team_leader",
    "planning",
  );
  db.prepare("INSERT INTO projects (id, name, project_path, core_goal) VALUES (?, ?, ?, ?)").run(
    "project-1",
    "Project",
    "/tmp/project",
    "Goal",
  );
  db.prepare(
    "INSERT INTO tasks (id, title, description, department_id, assigned_agent_id, status, project_id, project_path, result, source_task_id, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "task-1",
    "Ship feature",
    "Implement execution observability",
    "planning",
    "agent-1",
    "done",
    "project-1",
    "/tmp/project",
    "done",
    null,
    1000,
    1100,
    2000,
  );
  db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
    "task-1",
    "system",
    "RUN completed (exit code: 0)",
    1500,
  );
  db.prepare(
    "INSERT INTO task_execution_events (id, task_id, category, action, status, message, details_json, attempt_count, hook_source, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "event-1",
    "task-1",
    "retry",
    "queued",
    "warning",
    "Automatic retry scheduled",
    JSON.stringify({ reason: "hard_timeout" }),
    1,
    null,
    null,
    1800,
  );
  db.prepare(
    "INSERT INTO task_execution_events (id, task_id, category, action, status, message, details_json, attempt_count, hook_source, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "event-2",
    "task-1",
    "hook",
    "failure",
    "failure",
    "Task hook failed [after_run_failure] Hook A",
    JSON.stringify({ stage: "after_run_failure" }),
    null,
    "project",
    42,
    1900,
  );
  db.prepare(
    "INSERT INTO task_retry_queue (task_id, attempt_count, next_run_at, last_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("task-1", 1, 999999, "hard_timeout", 1800, 1800);

  return db;
}

function createHarness(db: DatabaseSync) {
  const getRoutes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      getRoutes.set(path, handler);
      return this;
    },
    post() {
      return this;
    },
  };

  registerTaskReportRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => 2_000_000,
    archivePlanningConsolidatedReport: async () => {},
  } as any);

  return { getRoutes };
}

describe("task report execution block", () => {
  it("report detail 응답에 execution summary와 events를 포함한다", () => {
    const db = setupDb();
    try {
      const { getRoutes } = createHarness(db);
      const handler = getRoutes.get("/api/task-reports/:taskId");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { taskId: "task-1" } }, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as any;
      expect(payload.execution.summary).toEqual({
        retry_count: 1,
        last_retry_reason: "hard_timeout",
        pending_retry: true,
        hook_failures: 1,
        project_hook_override_used: true,
        last_event_at: 1900,
      });
      expect(payload.execution.events).toHaveLength(2);
      expect(payload.execution.events[0]?.id).toBe("event-2");
    } finally {
      db.close();
    }
  });
});
