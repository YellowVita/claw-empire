import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { registerProjectRoutes } from "./projects.ts";

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

function createHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      core_goal TEXT NOT NULL,
      default_pack_key TEXT NOT NULL DEFAULT 'development',
      assignment_mode TEXT NOT NULL DEFAULT 'auto',
      last_used_at INTEGER,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      github_repo TEXT
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
    CREATE TABLE project_agents (
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at INTEGER DEFAULT 0,
      PRIMARY KEY (project_id, agent_id)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      department_id TEXT,
      status TEXT,
      task_type TEXT,
      priority INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      completed_at INTEGER,
      source_task_id TEXT,
      assigned_agent_id TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT,
      department_id TEXT,
      role TEXT
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT
    );
    CREATE TABLE project_review_decision_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      snapshot_hash TEXT,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      selected_options_json TEXT,
      note TEXT,
      task_id TEXT,
      meeting_id TEXT,
      created_at INTEGER DEFAULT 0
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
    "report",
    "Report",
    1,
    "{}",
    '{"mode":"reporting"}',
    '{"failOnMissingSections":true}',
    '{"sections":["summary"]}',
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

  registerProjectRoutes({
    app: app as any,
    db,
    firstQueryValue: (value: unknown) => {
      if (typeof value === "string") return value;
      return undefined;
    },
    normalizeTextField: (value: unknown) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    },
    runInTransaction: (fn: () => void) => fn(),
    nowMs: () => 1,
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

describe("project workflow pack detection", () => {
  it("GET /api/projects/:id는 file default pack을 best-effort로 반환한다", () => {
    const { db, routes } = createHarness();
    const projectPath = createTempDir("claw-project-pack-detail-");
    writeWorkflowConfig(projectPath, {
      defaultWorkflowPackKey: "report",
      packOverrides: {
        report: {
          prompt_preset: { mode: "project-report" },
        },
      },
    });
    try {
      db.prepare(
        "INSERT INTO projects (id, name, project_path, core_goal, default_pack_key, assignment_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("project-1", "Project", projectPath, "Goal", "development", "auto", 1, 1);

      const handler = routes.get("GET /api/projects/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "project-1" } }, res);

      expect(res.statusCode).toBe(200);
      expect((res.payload as any).project.detected_workflow_pack_key).toBe("report");
      expect((res.payload as any).project.workflow_pack_source).toBe("file_default");
      expect((res.payload as any).project.workflow_pack_override_applied).toBe(true);
      expect((res.payload as any).project.workflow_pack_override_fields).toEqual(["prompt_preset"]);
      expect((res.payload as any).project.workflow_pack_preview_key).toBe("report");
    } finally {
      db.close();
    }
  });

  it("GET /api/projects/:id는 파일을 읽지 못해도 project default로 fallback 한다", () => {
    const { db, routes } = createHarness();
    const projectPath = createTempDir("claw-project-pack-fallback-");
    writeWorkflowConfig(projectPath, "{ invalid json");
    try {
      db.prepare(
        "INSERT INTO projects (id, name, project_path, core_goal, default_pack_key, assignment_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("project-1", "Project", projectPath, "Goal", "novel", "auto", 1, 1);

      const handler = routes.get("GET /api/projects/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "project-1" } }, res);

      expect(res.statusCode).toBe(200);
      expect((res.payload as any).project.detected_workflow_pack_key).toBe("novel");
      expect((res.payload as any).project.workflow_pack_source).toBe("project_default");
      expect((res.payload as any).project.workflow_pack_override_applied).toBe(false);
      expect((res.payload as any).project.workflow_pack_override_fields).toEqual([]);
      expect((res.payload as any).project.workflow_pack_preview_key).toBe("novel");
    } finally {
      db.close();
    }
  });
});
