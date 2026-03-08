import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { registerTaskSubtaskRoutes, type TaskSubtaskRouteDeps } from "./subtasks.ts";

type RouteHandler = (req: any, res: any) => any;

function createRes() {
  return {
    statusCode: 200,
    payload: null as unknown,
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

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      assigned_agent_id TEXT,
      department_id TEXT
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      title TEXT,
      description TEXT,
      status TEXT,
      assigned_agent_id TEXT,
      blocked_reason TEXT,
      target_department_id TEXT,
      delegated_task_id TEXT,
      created_at INTEGER,
      completed_at INTEGER
    );
  `);

  const routes = new Map<string, RouteHandler>();
  const app = {
    get: vi.fn((path: string, handler: RouteHandler) => routes.set(`GET ${path}`, handler)),
    post: vi.fn((path: string, handler: RouteHandler) => routes.set(`POST ${path}`, handler)),
    patch: vi.fn((path: string, handler: RouteHandler) => routes.set(`PATCH ${path}`, handler)),
  };

  const deps: TaskSubtaskRouteDeps = {
    app: app as any,
    db: db as any,
    firstQueryValue: vi.fn(),
    nowMs: () => 1234,
    analyzeSubtaskDepartment: vi.fn(),
    getDeptName: vi.fn((deptId: string) => deptId),
    broadcast: vi.fn(),
    appendTaskLog: vi.fn(),
    findTeamLeader: vi.fn(),
    resolveLang: vi.fn(() => "ko"),
    getAgentDisplayName: vi.fn(() => "Agent"),
    sendAgentMessage: vi.fn(),
    pickL: ((pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0]) as any,
    l: ((ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh })) as any,
    processSubtaskDelegations: vi.fn(),
  };

  registerTaskSubtaskRoutes(deps);
  const actionRoute = routes.get("POST /api/subtasks/:id/action");
  if (!actionRoute) throw new Error("action route missing");

  return { db, deps, actionRoute };
}

describe("subtask action routes", () => {
  it("retries a blocked subtask and triggers delegation", () => {
    const { db, deps, actionRoute } = setup();
    db.prepare("INSERT INTO tasks (id, title, assigned_agent_id, department_id) VALUES (?, ?, ?, ?)").run(
      "task-1",
      "Parent task",
      "dev-1",
      "dev",
    );
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, status, assigned_agent_id, blocked_reason, target_department_id, delegated_task_id, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sub-1", "task-1", "QA verify", "blocked", null, "QA 팀장 부재", "qa", null, 1, null);

    const res = createRes();
    actionRoute({ params: { id: "sub-1" }, body: { action: "retry" } }, res);

    const updated = db.prepare("SELECT status, blocked_reason, delegated_task_id FROM subtasks WHERE id = ?").get("sub-1") as {
      status: string;
      blocked_reason: string | null;
      delegated_task_id: string | null;
    };

    expect(res.statusCode).toBe(200);
    expect(updated.status).toBe("pending");
    expect(updated.blocked_reason).toBeNull();
    expect(updated.delegated_task_id).toBeNull();
    expect(deps.processSubtaskDelegations).toHaveBeenCalledWith("task-1");
  });

  it("moves a blocked subtask back to the owner team", () => {
    const { db, deps, actionRoute } = setup();
    db.prepare("INSERT INTO tasks (id, title, assigned_agent_id, department_id) VALUES (?, ?, ?, ?)").run(
      "task-1",
      "Parent task",
      "dev-1",
      "dev",
    );
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, status, assigned_agent_id, blocked_reason, target_department_id, delegated_task_id, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sub-1", "task-1", "QA verify", "blocked", null, "QA 팀장 부재", "qa", null, 1, null);

    const res = createRes();
    actionRoute({ params: { id: "sub-1" }, body: { action: "move_to_owner" } }, res);

    const updated = db
      .prepare("SELECT status, target_department_id, blocked_reason, assigned_agent_id FROM subtasks WHERE id = ?")
      .get("sub-1") as {
      status: string;
      target_department_id: string | null;
      blocked_reason: string | null;
      assigned_agent_id: string | null;
    };

    expect(res.statusCode).toBe(200);
    expect(updated.status).toBe("pending");
    expect(updated.target_department_id).toBeNull();
    expect(updated.blocked_reason).toBeNull();
    expect(updated.assigned_agent_id).toBe("dev-1");
    expect(deps.processSubtaskDelegations).not.toHaveBeenCalled();
  });
});
