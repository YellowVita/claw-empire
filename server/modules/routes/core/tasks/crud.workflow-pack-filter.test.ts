import fs from "node:fs";
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

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeWorkflowConfig(projectPath: string, raw: Record<string, unknown> | string): void {
  const content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  fs.writeFileSync(path.join(projectPath, ".claw-workflow.json"), content, "utf8");
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
  ).run(
    "development",
    "Development",
    1,
    "{}",
    '{"mode":"engineering"}',
    '{"requireTestEvidence":true}',
    '{"sections":["summary"]}',
    '["fix","bug"]',
    '{"maxRounds":3}',
    1,
    1,
  );
  db.prepare(
    `
      INSERT INTO workflow_packs (
        key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
        output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "report",
    "Report",
    1,
    "{}",
    '{"mode":"reporting"}',
    '{"failOnMissingSections":true}',
    '{"sections":["summary","body"]}',
    '["report"]',
    '{"maxRounds":2}',
    1,
    1,
  );
  db.prepare(
    `
      INSERT INTO workflow_packs (
        key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
        output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "novel",
    "Novel",
    1,
    "{}",
    '{"mode":"narrative"}',
    '{"requireOutline":true}',
    '{"sections":["hook"]}',
    '["novel"]',
    '{"maxRounds":1}',
    1,
    1,
  );

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

  registerTaskCrudRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => Date.now(),
    firstQueryValue: (value: unknown) => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const first = value.find((item) => typeof item === "string");
        return typeof first === "string" ? first : undefined;
      }
      return undefined;
    },
    reconcileCrossDeptSubtasks: () => {},
    normalizeTextField: (raw: unknown) => {
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
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
    logsDir: "/tmp",
  });

  return { db, routes };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("task CRUD workflow pack filter", () => {
  it("GET /api/tasks는 workflow_pack_key 필터를 적용한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id,
            status, priority, task_type, workflow_pack_key, workflow_meta_json, output_format,
            project_path, base_branch, result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-report-1",
        "Report task",
        null,
        null,
        null,
        null,
        "inbox",
        1,
        "general",
        "report",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id,
            status, priority, task_type, workflow_pack_key, workflow_meta_json, output_format,
            project_path, base_branch, result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-dev-1",
        "Dev task",
        null,
        null,
        null,
        null,
        "inbox",
        1,
        "general",
        "development",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );

      const handler = routes.get("GET /api/tasks");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ query: { workflow_pack_key: "report" } }, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { tasks: Array<{ id: string; workflow_pack_key: string }> };
      expect(payload.tasks).toHaveLength(1);
      expect(payload.tasks[0]).toMatchObject({
        id: "task-report-1",
        workflow_pack_key: "report",
      });
    } finally {
      db.close();
    }
  });

  it("GET /api/tasks는 invalid workflow_pack_key에 400을 반환한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      const handler = routes.get("GET /api/tasks");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ query: { workflow_pack_key: "invalid-pack" } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: "invalid_workflow_pack_key" });
    } finally {
      db.close();
    }
  });

  it("POST /api/tasks는 workflow_pack_key 미지정 시 프로젝트 default_pack_key를 상속한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        `
          INSERT INTO projects (id, name, core_goal, project_path, default_pack_key)
          VALUES (?, ?, ?, ?, ?)
        `,
      ).run("project-novel", "Novel Project", "goal", "/tmp/novel-project", "novel");

      const handler = routes.get("POST /api/tasks") as RouteHandler | undefined;
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.(
        {
          body: {
            title: "Project-default pack task",
            project_id: "project-novel",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      const payload = res.payload as {
        task: { workflow_pack_key: string; project_id: string; project_path: string; workflow_meta_json: string | null };
      };
      expect(payload.task.workflow_pack_key).toBe("novel");
      expect((payload.task as any).workflow_pack_source).toBe("project_default");
      expect(payload.task.project_id).toBe("project-novel");
      expect(payload.task.project_path).toBe(path.normalize("/tmp/novel-project"));
      const meta = JSON.parse(payload.task.workflow_meta_json ?? "{}");
      expect(meta.pack_override_source).toBeNull();
      expect(meta.pack_override_fields).toEqual([]);
      expect(meta.effective_pack_snapshot).toMatchObject({
        key: "novel",
        prompt_preset: { mode: "narrative" },
      });
    } finally {
      db.close();
    }
  });

  it("POST /api/tasks는 project_path의 file default pack을 우선 적용한다", () => {
    const { db, routes } = createTaskCrudHarness();
    const projectPath = createTempDir("claw-task-pack-project-");
    writeWorkflowConfig(projectPath, {
      defaultWorkflowPackKey: "report",
      packOverrides: {
        report: {
          prompt_preset: { mode: "project-report" },
          routing_keywords: ["project-only"],
        },
      },
    });
    try {
      const handler = routes.get("POST /api/tasks") as RouteHandler | undefined;
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.(
        {
          body: {
            title: "File-default pack task",
            project_path: projectPath,
          },
        },
        res,
      );

      const payload = res.payload as {
        task: { workflow_pack_key: string; workflow_pack_source: string; workflow_meta_json: string | null };
      };
      expect(res.statusCode).toBe(200);
      expect(payload.task.workflow_pack_key).toBe("report");
      expect(payload.task.workflow_pack_source).toBe("file_default");
      const meta = JSON.parse(payload.task.workflow_meta_json ?? "{}");
      expect(meta.pack_override_source).toBe("file");
      expect(meta.pack_override_fields).toEqual(["prompt_preset", "routing_keywords"]);
      expect(meta.effective_pack_snapshot).toMatchObject({
        key: "report",
        prompt_preset: { mode: "project-report" },
        routing_keywords: ["project-only"],
        qa_rules: { failOnMissingSections: true },
      });
    } finally {
      db.close();
    }
  });

  it("PATCH /api/tasks/:id는 project_path 변경 시 file default pack과 source를 다시 저장한다", () => {
    const { db, routes } = createTaskCrudHarness();
    const projectPath = createTempDir("claw-task-pack-patch-");
    writeWorkflowConfig(projectPath, {
      defaultWorkflowPackKey: "report",
      packOverrides: {
        report: {
          qa_rules: { requireApproval: true },
        },
      },
    });
    try {
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id,
            status, priority, task_type, workflow_pack_key, workflow_pack_source, workflow_meta_json, output_format,
            project_path, base_branch, result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-1",
        "Task One",
        null,
        null,
        null,
        null,
        "inbox",
        1,
        "general",
        "development",
        "fallback_default",
        "{\"custom\":\"keep\"}",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );

      const handler = routes.get("PATCH /api/tasks/:id") as RouteHandler | undefined;
      expect(handler).toBeTypeOf("function");
      const res = createFakeResponse();
      handler?.({ params: { id: "task-1" }, body: { project_path: projectPath } }, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as {
        task: { workflow_pack_key: string; workflow_pack_source: string; workflow_meta_json: string | null };
      };
      expect(payload.task.workflow_pack_key).toBe("report");
      expect(payload.task.workflow_pack_source).toBe("file_default");
      const meta = JSON.parse(payload.task.workflow_meta_json ?? "{}");
      expect(meta.custom).toBe("keep");
      expect(meta.pack_override_source).toBe("file");
      expect(meta.pack_override_fields).toEqual(["qa_rules"]);
      expect(meta.effective_pack_snapshot).toMatchObject({
        key: "report",
        qa_rules: { requireApproval: true },
      });
    } finally {
      db.close();
    }
  });
});
