import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { registerAgentProcessInspectorRoutes } from "./process-inspector.ts";

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
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT,
      status TEXT NOT NULL,
      current_task_id TEXT
    );
    CREATE TABLE task_retry_queue (
      task_id TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  const routes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
      return this;
    },
    delete(path: string, handler: RouteHandler) {
      routes.set(`DELETE ${path}`, handler);
      return this;
    },
  };

  const killPidTree = vi.fn();
  const stopProgressTimer = vi.fn();
  const endTaskExecutionSession = vi.fn();
  const clearTaskWorkflowState = vi.fn();
  const rollbackTaskWorktree = vi.fn(() => true);
  const appendTaskLog = vi.fn();
  const broadcast = vi.fn();
  const activeProcesses = new Map<string, { pid: number }>([["task-1", { pid: 4242 }]]);
  const stopRequestedTasks = new Set<string>();
  const stopRequestModeByTask = new Map<string, "pause" | "cancel">();
  const taskExecutionSessions = new Map();

  registerAgentProcessInspectorRoutes({
    app: app as any,
    db: db as any,
    activeProcesses: activeProcesses as any,
    taskExecutionSessions,
    killPidTree,
    stopRequestedTasks,
    stopRequestModeByTask,
    stopProgressTimer,
    endTaskExecutionSession,
    clearTaskWorkflowState,
    rollbackTaskWorktree,
    appendTaskLog,
    broadcast,
    nowMs: () => 987654,
  } as any);

  return {
    db,
    routes,
    spies: {
      killPidTree,
      stopProgressTimer,
      endTaskExecutionSession,
      clearTaskWorkflowState,
      rollbackTaskWorktree,
      appendTaskLog,
      broadcast,
    },
    maps: {
      activeProcesses,
      stopRequestedTasks,
      stopRequestModeByTask,
    },
  };
}

describe("agent process inspector cleanup", () => {
  it("force kill 시 task를 cancelled로 내리고 rollback cleanup을 수행한다", () => {
    const harness = createHarness();
    try {
      harness.db.prepare("INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)").run(
        "task-1",
        "Inspector task",
        "in_progress",
        1,
      );
      harness.db
        .prepare("INSERT INTO agents (id, name, name_ko, status, current_task_id) VALUES (?, ?, ?, ?, ?)")
        .run("agent-1", "Agent One", "에이전트 원", "working", "task-1");
      harness.db
        .prepare(
          "INSERT INTO task_retry_queue (task_id, attempt_count, next_run_at, last_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("task-1", 1, 1, "idle_timeout", 1, 1);

      const handler = harness.routes.get("DELETE /api/agents/cli-processes/:pid");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { pid: "4242" } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({ ok: true, pid: 4242, tracked_task_id: "task-1" });
      expect(harness.spies.killPidTree).toHaveBeenCalledWith(4242);
      expect(harness.spies.stopProgressTimer).toHaveBeenCalledWith("task-1");
      expect(harness.spies.endTaskExecutionSession).toHaveBeenCalledWith("task-1", "process_inspector_cancel");
      expect(harness.spies.clearTaskWorkflowState).toHaveBeenCalledWith("task-1");
      expect(harness.spies.rollbackTaskWorktree).toHaveBeenCalledWith("task-1", "process_inspector_cancel");
      expect(harness.db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1")).toEqual({ status: "cancelled" });
      expect(harness.db.prepare("SELECT status, current_task_id FROM agents WHERE id = ?").get("agent-1")).toEqual({
        status: "idle",
        current_task_id: null,
      });
      expect(harness.db.prepare("SELECT * FROM task_retry_queue WHERE task_id = ?").get("task-1")).toBeUndefined();
      expect(harness.maps.activeProcesses.has("task-1")).toBe(false);
      expect(harness.maps.stopRequestedTasks.has("task-1")).toBe(true);
      expect(harness.maps.stopRequestModeByTask.get("task-1")).toBe("cancel");
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
});
