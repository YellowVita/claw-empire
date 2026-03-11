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
      workflow_pack_key TEXT NOT NULL DEFAULT 'development',
      result TEXT,
      source_task_id TEXT,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER
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
    CREATE TABLE task_quality_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      quality_item_id TEXT,
      run_type TEXT NOT NULL,
      name TEXT NOT NULL,
      command TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      summary TEXT,
      output_excerpt TEXT,
      metadata_json TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      quality_item_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT,
      mime TEXT,
      size_bytes INTEGER,
      source TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_run_sheets (
      task_id TEXT PRIMARY KEY,
      workflow_pack_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_markdown TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
    "INSERT INTO tasks (id, title, description, department_id, assigned_agent_id, status, project_id, project_path, workflow_pack_key, result, source_task_id, created_at, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "task-1",
    "Ship feature",
    "Implement execution observability",
    "planning",
    "agent-1",
    "done",
    "project-1",
    "/tmp/project",
    "development",
    "done",
    null,
    1000,
    1100,
    2000,
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
  db.prepare(
    "INSERT INTO task_quality_items (id, task_id, kind, label, details, required, status, evidence_markdown, source, sort_order, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("quality-1", "task-1", "validation", "Video verified", null, 1, "passed", null, "system", 0, 1000, 1000, 1900);
  db.prepare(
    "INSERT INTO task_quality_runs (id, task_id, quality_item_id, run_type, name, status, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("quality-run-1", "task-1", null, "artifact_check", "video gate", "passed", "verified", '{"path":"/tmp/project/video_output/final.mp4"}', 1950);
  db.prepare(
    "INSERT INTO task_artifacts (id, task_id, quality_item_id, kind, title, path, source, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "artifact-1",
    "task-1",
    null,
    "video",
    "final.mp4",
    "/tmp/project/video_output/final.mp4",
    "video_gate",
    '{"verified":true}',
    1960,
  );
  db.prepare(
    "INSERT INTO task_run_sheets (task_id, workflow_pack_key, stage, status, summary_markdown, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "task-1",
    "development",
    "done",
    "done",
    "# Development Run Sheet",
    JSON.stringify({
      current_plan: { title: "Ship feature", description: "Implement execution observability", latest_report: null, project_path: "/tmp/project" },
      reproduction: { status: "not_recorded", evidence: [] },
      implementation: { result_summary: null, latest_report: null, diff_summary: null, log_highlights: [] },
      validation: {
        required_total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        blocked_review: false,
        pending_retry: true,
        recent_runs: [],
        artifacts: [],
      },
      review_checklist: {
        entered_review: true,
        blocked_review: false,
        waiting_on_subtasks: false,
        waiting_on_child_reviews: false,
        pending_retry: true,
        merge_status: "merged",
        pr_feedback_gate: {
          applicable: true,
          status: "passed",
          pr_url: "https://github.com/acme/repo/pull/12",
          unresolved_thread_count: 0,
          change_requests_count: 0,
          failing_check_count: 0,
          pending_check_count: 0,
          ignored_check_count: 2,
          ignored_check_names: ["optional / preview", "optional / smoke"],
          blocking_reasons: [],
          checked_at: 1990,
        },
      },
      handoff: { status: "done", summary: "done" },
      timeline: { created_at: 1000, started_at: 1100, review_entered_at: 1900, completed_at: 2000, updated_at: 2000 },
    }),
    1000,
    2000,
  );

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
      expect(payload.development_run_sheet).toEqual(
        expect.objectContaining({
          task_id: "task-1",
          stage: "done",
          synthetic: false,
          summary_markdown: "# Development Run Sheet",
        }),
      );
      expect(payload.development_run_sheet.snapshot.review_checklist.pr_feedback_gate).toEqual(
        expect.objectContaining({
          status: "passed",
          pr_url: "https://github.com/acme/repo/pull/12",
          ignored_check_count: 2,
          ignored_check_names: ["optional / preview", "optional / smoke"],
        }),
      );
      expect(payload.quality).toEqual({
        items: [
          expect.objectContaining({
            id: "quality-1",
            label: "Video verified",
          }),
        ],
        summary: {
          required_total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          blocked_review: false,
        },
        runs: [
          expect.objectContaining({
            id: "quality-run-1",
            name: "video gate",
          }),
        ],
        artifacts: [
          expect.objectContaining({
            id: "artifact-1",
            title: "final.mp4",
          }),
        ],
      });
    } finally {
      db.close();
    }
  });

  it("run sheet가 없고 development pending task면 synthetic queued run sheet를 응답한다", () => {
    const db = setupDb();
    try {
      db.prepare("DELETE FROM task_run_sheets WHERE task_id = ?").run("task-1");
      db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, completed_at = NULL WHERE id = ?").run("task-1");

      const { getRoutes } = createHarness(db);
      const handler = getRoutes.get("/api/task-reports/:taskId");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { taskId: "task-1" } }, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as any;
      expect(payload.development_run_sheet).toEqual(
        expect.objectContaining({
          task_id: "task-1",
          stage: "queued",
          status: "pending",
          synthetic: true,
        }),
      );
    } finally {
      db.close();
    }
  });
});
