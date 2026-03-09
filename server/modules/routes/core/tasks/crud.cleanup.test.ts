import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { registerTaskCrudRoutes } from "./crud.ts";

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

function createHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      assigned_agent_id TEXT,
      project_id TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      task_type TEXT NOT NULL DEFAULT 'general',
      workflow_pack_key TEXT NOT NULL DEFAULT 'development',
      workflow_meta_json TEXT,
      output_format TEXT,
      project_path TEXT,
      base_branch TEXT,
      result TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      source_task_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL,
      current_task_id TEXT,
      avatar_emoji TEXT
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      core_goal TEXT,
      project_path TEXT,
      default_pack_key TEXT NOT NULL DEFAULT 'development',
      last_used_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      delegated_task_id TEXT
    );
    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      kind TEXT,
      message TEXT,
      created_at INTEGER
    );
    CREATE TABLE task_retry_queue (
      task_id TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE task_quality_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      role TEXT,
      content TEXT,
      created_at INTEGER
    );
  `);

  const routes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
      return this;
    },
    post(path: string, handler: RouteHandler) {
      routes.set(`POST ${path}`, handler);
      return this;
    },
    patch(path: string, handler: RouteHandler) {
      routes.set(`PATCH ${path}`, handler);
      return this;
    },
    delete(path: string, handler: RouteHandler) {
      routes.set(`DELETE ${path}`, handler);
      return this;
    },
  };

  const rollbackTaskWorktree = vi.fn(() => true);
  const clearTaskWorkflowState = vi.fn();
  const endTaskExecutionSession = vi.fn();
  const stopProgressTimer = vi.fn();
  const broadcast = vi.fn();
  const appendTaskLog = vi.fn();
  const killPidTree = vi.fn();
  const activeProcesses = new Map<string, { pid: number; kill?: () => void }>();
  const stopRequestedTasks = new Set<string>();
  const stopRequestModeByTask = new Map<string, "pause" | "cancel">();
  const taskWorktrees = new Map<string, { worktreePath: string; branchName: string; projectPath: string }>();

  registerTaskCrudRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => 123456,
    firstQueryValue: (value: unknown) => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
      return undefined;
    },
    reconcileCrossDeptSubtasks: () => {},
    normalizeTextField: (raw: unknown) => {
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    recordTaskCreationAudit: () => {},
    appendTaskLog,
    broadcast,
    setTaskCreationAuditCompletion: () => {},
    clearTaskWorkflowState,
    endTaskExecutionSession,
    activeProcesses: activeProcesses as any,
    stopRequestModeByTask,
    stopProgressTimer,
    stopRequestedTasks,
    killPidTree,
    taskWorktrees,
    rollbackTaskWorktree,
    logsDir: os.tmpdir(),
  });

  return {
    db,
    routes,
    spies: {
      rollbackTaskWorktree,
      clearTaskWorkflowState,
      endTaskExecutionSession,
      stopProgressTimer,
      broadcast,
      appendTaskLog,
      killPidTree,
    },
    maps: {
      activeProcesses,
      stopRequestedTasks,
      stopRequestModeByTask,
      taskWorktrees,
    },
  };
}

describe("task CRUD cleanup paths", () => {
  it("PATCH /api/tasks/:id 에서 cancelled 전환 시 rollback과 agent 해제를 수행한다", () => {
    const harness = createHarness();
    try {
      harness.db
        .prepare(
          `INSERT INTO tasks (
            id, title, status, assigned_agent_id, workflow_pack_key, task_type, priority, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("task-1", "Cleanup me", "in_progress", "agent-1", "development", "general", 0, 0, 1, 1);
      harness.db
        .prepare("INSERT INTO agents (id, name, status, current_task_id, avatar_emoji) VALUES (?, ?, ?, ?, ?)")
        .run("agent-1", "Agent One", "working", "task-1", null);
      harness.db
        .prepare(
          "INSERT INTO task_retry_queue (task_id, attempt_count, next_run_at, last_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("task-1", 1, 1, "idle_timeout", 1, 1);
      harness.maps.taskWorktrees.set("task-1", {
        worktreePath: "/tmp/task-1",
        branchName: "climpire/task-1",
        projectPath: "/tmp/project-1",
      });

      const handler = harness.routes.get("PATCH /api/tasks/:id");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: "task-1" }, body: { status: "cancelled" } }, res);

      expect(res.statusCode).toBe(200);
      expect(harness.spies.rollbackTaskWorktree).toHaveBeenCalledWith("task-1", "task_status_cancelled");
      expect(harness.spies.clearTaskWorkflowState).toHaveBeenCalledWith("task-1");
      expect(harness.spies.endTaskExecutionSession).toHaveBeenCalledWith("task-1", "task_status_cancelled");
      expect(harness.db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1")).toEqual({ status: "cancelled" });
      expect(harness.db.prepare("SELECT status, current_task_id FROM agents WHERE id = ?").get("agent-1")).toEqual({
        status: "idle",
        current_task_id: null,
      });
      expect(harness.db.prepare("SELECT * FROM task_retry_queue WHERE task_id = ?").get("task-1")).toBeUndefined();
      expect(harness.spies.broadcast).toHaveBeenCalledWith(
        "task_update",
        expect.objectContaining({ id: "task-1", status: "cancelled" }),
      );
      expect(harness.spies.broadcast).toHaveBeenCalledWith(
        "agent_status",
        expect.objectContaining({ id: "agent-1", status: "idle", current_task_id: null }),
      );
    } finally {
      harness.db.close();
    }
  });

  it("PATCH /api/tasks/:id 에서 pending 전환 시 rollback 없이 상태만 정리한다", () => {
    const harness = createHarness();
    try {
      harness.db
        .prepare(
          `INSERT INTO tasks (
            id, title, status, assigned_agent_id, workflow_pack_key, task_type, priority, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("task-pending", "Pause me", "in_progress", "agent-1", "development", "general", 0, 0, 1, 1);

      const handler = harness.routes.get("PATCH /api/tasks/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "task-pending" }, body: { status: "pending" } }, res);

      expect(res.statusCode).toBe(200);
      expect(harness.spies.rollbackTaskWorktree).not.toHaveBeenCalled();
      expect(harness.spies.endTaskExecutionSession).not.toHaveBeenCalled();
      expect(harness.db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-pending")).toEqual({
        status: "pending",
      });
    } finally {
      harness.db.close();
    }
  });

  it("DELETE /api/tasks/:id 는 삭제 전에 rollback cleanup을 수행한다", () => {
    const harness = createHarness();
    try {
      harness.db
        .prepare(
          `INSERT INTO tasks (
            id, title, status, assigned_agent_id, workflow_pack_key, task_type, priority, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("task-delete", "Delete me", "review", "agent-1", "development", "general", 0, 0, 1, 1);
      harness.db
        .prepare("INSERT INTO agents (id, name, status, current_task_id, avatar_emoji) VALUES (?, ?, ?, ?, ?)")
        .run("agent-1", "Agent One", "working", "task-delete", null);
      harness.db
        .prepare(
          "INSERT INTO task_quality_runs (id, task_id, quality_item_id, run_type, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("run-1", "task-delete", null, "system", "evidence", "passed", 1);
      harness.db
        .prepare(
          "INSERT INTO task_artifacts (id, task_id, quality_item_id, kind, title, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("artifact-1", "task-delete", null, "report_archive", "archive", "system", 1);
      harness.maps.taskWorktrees.set("task-delete", {
        worktreePath: "/tmp/task-delete",
        branchName: "climpire/task-delete",
        projectPath: "/tmp/project-delete",
      });

      const handler = harness.routes.get("DELETE /api/tasks/:id");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: "task-delete" } }, res);

      expect(res.statusCode).toBe(200);
      expect(harness.spies.rollbackTaskWorktree).toHaveBeenCalledWith("task-delete", "task_deleted");
      expect(harness.spies.endTaskExecutionSession).toHaveBeenCalledWith("task-delete", "task_deleted");
      expect(harness.spies.clearTaskWorkflowState).toHaveBeenCalledWith("task-delete");
      expect(harness.db.prepare("SELECT * FROM tasks WHERE id = ?").get("task-delete")).toBeUndefined();
      expect(harness.db.prepare("SELECT * FROM task_quality_runs WHERE task_id = ?").get("task-delete")).toBeUndefined();
      expect(harness.db.prepare("SELECT * FROM task_artifacts WHERE task_id = ?").get("task-delete")).toBeUndefined();
      expect(harness.db.prepare("SELECT status, current_task_id FROM agents WHERE id = ?").get("agent-1")).toEqual({
        status: "idle",
        current_task_id: null,
      });
    } finally {
      harness.db.close();
    }
  });

  it("GET /api/tasks/:id/quality 는 runs와 artifacts를 함께 반환한다", () => {
    const harness = createHarness();
    try {
      harness.db
        .prepare(
          `INSERT INTO tasks (
            id, title, status, workflow_pack_key, task_type, priority, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("task-quality", "Quality", "review", "development", "general", 0, 0, 1, 1);
      harness.db
        .prepare(
          "INSERT INTO task_quality_items (id, task_id, kind, label, status, required, source, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("item-1", "task-quality", "validation", "Video verified", "passed", 1, "system", 0, 1, 1);
      harness.db
        .prepare(
          "INSERT INTO task_quality_runs (id, task_id, quality_item_id, run_type, name, status, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("run-1", "task-quality", null, "artifact_check", "video gate", "passed", "verified", '{"path":"/tmp/video.mp4"}', 2);
      harness.db
        .prepare(
          "INSERT INTO task_artifacts (id, task_id, quality_item_id, kind, title, path, source, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "artifact-1",
          "task-quality",
          null,
          "video",
          "final.mp4",
          "/tmp/video.mp4",
          "video_gate",
          '{"verified":true}',
          3,
        );

      const handler = harness.routes.get("GET /api/tasks/:id/quality");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: "task-quality" } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({
        items: [
          expect.objectContaining({
            id: "item-1",
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
            id: "run-1",
            name: "video gate",
            metadata: { path: "/tmp/video.mp4" },
          }),
        ],
        artifacts: [
          expect.objectContaining({
            id: "artifact-1",
            title: "final.mp4",
            path: "/tmp/video.mp4",
            metadata: { verified: true },
          }),
        ],
      });
    } finally {
      harness.db.close();
    }
  });
});
