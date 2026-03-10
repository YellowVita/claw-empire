import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

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

function createTaskCrudHarness(): { db: DatabaseSync; routes: Map<string, RouteHandler> } {
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
      priority INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      workflow_pack_key TEXT NOT NULL DEFAULT 'development',
      workflow_pack_source TEXT,
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
      status TEXT,
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
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE workflow_packs (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      input_schema_json TEXT NOT NULL,
      prompt_preset_json TEXT NOT NULL,
      qa_rules_json TEXT NOT NULL,
      output_template_json TEXT NOT NULL,
      routing_keywords_json TEXT NOT NULL,
      cost_profile_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      delegated_task_id TEXT
    );
  `);
  db.prepare(
    `
      INSERT INTO workflow_packs (
        key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
        output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run("development", "Development", 1, "{}", "{}", "{}", "{}", "[]", "{}", 1, 1);

  const routes = new Map<string, RouteHandler>();
  const app = {
    get(routePath: string, handler: RouteHandler) {
      routes.set(`GET ${routePath}`, handler);
      return this;
    },
    post(routePath: string, handler: RouteHandler) {
      routes.set(`POST ${routePath}`, handler);
      return this;
    },
    patch(routePath: string, handler: RouteHandler) {
      routes.set(`PATCH ${routePath}`, handler);
      return this;
    },
    delete(routePath: string, handler: RouteHandler) {
      routes.set(`DELETE ${routePath}`, handler);
      return this;
    },
  };

  registerTaskCrudRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => 1000,
    firstQueryValue: (value: unknown) => (typeof value === "string" ? value : undefined),
    reconcileCrossDeptSubtasks: () => {},
    normalizeTextField: (value: unknown) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    recordTaskCreationAudit: () => {},
    appendTaskLog: () => {},
    broadcast: () => {},
    setTaskCreationAuditCompletion: () => {},
    clearTaskWorkflowState: () => {},
    endTaskExecutionSession: () => {},
    activeProcesses: new Map(),
    stopRequestModeByTask: new Map(),
    stopProgressTimer: () => {},
    stopRequestedTasks: new Set(),
    killPidTree: () => {},
    taskWorktrees: new Map(),
    rollbackTaskWorktree: () => false,
    logsDir: os.tmpdir(),
  });

  return { db, routes };
}

const originalAllowedRoots = process.env.PROJECT_PATH_ALLOWED_ROOTS;

afterEach(() => {
  if (originalAllowedRoots === undefined) {
    delete process.env.PROJECT_PATH_ALLOWED_ROOTS;
  } else {
    process.env.PROJECT_PATH_ALLOWED_ROOTS = originalAllowedRoots;
  }
});

describe("task CRUD project path policy", () => {
  it("rejects relative project_path on task create", () => {
    delete process.env.PROJECT_PATH_ALLOWED_ROOTS;
    const { db, routes } = createTaskCrudHarness();
    try {
      const handler = routes.get("POST /api/tasks");
      const res = createFakeResponse();

      handler?.({ body: { title: "Relative", project_path: "../bad-path" } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: "relative_project_path_not_allowed" });
      expect(db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get()).toEqual({ cnt: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects project_path outside allowed roots on task create", () => {
    process.env.PROJECT_PATH_ALLOWED_ROOTS = path.join(os.tmpdir(), "allowed-root");
    const { db, routes } = createTaskCrudHarness();
    try {
      const handler = routes.get("POST /api/tasks");
      const res = createFakeResponse();

      handler?.({ body: { title: "Outside", project_path: path.join(os.tmpdir(), "outside-root", "project") } }, res);

      expect(res.statusCode).toBe(403);
      expect(res.payload).toEqual({ error: "project_path_outside_allowed_roots" });
      expect(db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get()).toEqual({ cnt: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects conflicting project_id and project_path on task create", () => {
    delete process.env.PROJECT_PATH_ALLOWED_ROOTS;
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        "INSERT INTO projects (id, name, core_goal, project_path, default_pack_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("project-1", "Project One", "goal", "/tmp/project-one", "development", 1, 1);

      const handler = routes.get("POST /api/tasks");
      const res = createFakeResponse();
      handler?.(
        {
          body: {
            title: "Conflict",
            project_id: "project-1",
            project_path: "/tmp/other-project",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.payload).toEqual({ error: "conflicting_project_path_sources" });
      expect(db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get()).toEqual({ cnt: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects relative project_path on patch without applying other fields", () => {
    delete process.env.PROJECT_PATH_ALLOWED_ROOTS;
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id, status, priority, task_type,
            workflow_pack_key, workflow_pack_source, workflow_meta_json, output_format, project_path, base_branch,
            result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-1",
        "Original",
        "keep",
        null,
        null,
        null,
        "inbox",
        0,
        "general",
        "development",
        "fallback_default",
        "{}",
        null,
        "/tmp/original-project",
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );

      const handler = routes.get("PATCH /api/tasks/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "task-1" }, body: { title: "Changed", project_path: "../bad-path" } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: "relative_project_path_not_allowed" });
      expect(db.prepare("SELECT title, project_path FROM tasks WHERE id = ?").get("task-1")).toEqual({
        title: "Original",
        project_path: "/tmp/original-project",
      });
    } finally {
      db.close();
    }
  });

  it("rejects conflicting project_id and project_path on patch", () => {
    delete process.env.PROJECT_PATH_ALLOWED_ROOTS;
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        "INSERT INTO projects (id, name, core_goal, project_path, default_pack_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("project-1", "Project One", "goal", "/tmp/project-one", "development", 1, 1);
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id, status, priority, task_type,
            workflow_pack_key, workflow_pack_source, workflow_meta_json, output_format, project_path, base_branch,
            result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-1",
        "Original",
        null,
        null,
        null,
        "project-1",
        "inbox",
        0,
        "general",
        "development",
        "project_default",
        "{}",
        null,
        "/tmp/project-one",
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );

      const handler = routes.get("PATCH /api/tasks/:id");
      const res = createFakeResponse();
      handler?.(
        {
          params: { id: "task-1" },
          body: { project_id: "project-1", project_path: "/tmp/other-project" },
        },
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.payload).toEqual({ error: "conflicting_project_path_sources" });
      expect(db.prepare("SELECT project_id, project_path FROM tasks WHERE id = ?").get("task-1")).toEqual({
        project_id: "project-1",
        project_path: "/tmp/project-one",
      });
    } finally {
      db.close();
    }
  });
});
