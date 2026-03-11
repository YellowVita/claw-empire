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
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
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
      description TEXT,
      status TEXT,
      task_type TEXT,
      priority INTEGER,
      project_path TEXT,
      result TEXT,
      workflow_pack_key TEXT,
      workflow_meta_json TEXT,
      created_at INTEGER,
      started_at INTEGER,
      updated_at INTEGER,
      completed_at INTEGER,
      source_task_id TEXT,
      assigned_agent_id TEXT,
      department_id TEXT
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
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
    CREATE TABLE task_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);

  for (const [key, name, promptPreset] of [
    ["development", "Development", '{"mode":"engineering"}'],
    ["report", "Report", '{"mode":"reporting"}'],
  ]) {
    db.prepare(
      `
        INSERT INTO workflow_packs (
          key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
          output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(key, name, 1, "{}", promptPreset, "{}", "{}", "[]", "{}", 1, 1);
  }

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
    firstQueryValue: (value: unknown) => (typeof value === "string" ? value : undefined),
    normalizeTextField: (value: unknown) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    },
    runInTransaction: (fn: () => void) => fn(),
    nowMs: () => 1700000000000,
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

describe("project development workflow health", () => {
  it("GET /api/projects/:id aggregates development workflow health from root tasks", () => {
    const { db, routes } = createHarness();
    const projectPath = createTempDir("claw-project-health-");
    fs.writeFileSync(
      path.join(projectPath, ".claw-workflow.json"),
      JSON.stringify({
        defaultWorkflowPackKey: "development",
        packOverrides: {
          development: {
            prompt_preset: { mode: "project-dev" },
          },
        },
      }),
      "utf8",
    );

    try {
      db.prepare(
        "INSERT INTO projects (id, name, project_path, core_goal, default_pack_key, assignment_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("project-1", "Project", projectPath, "Goal", "development", "auto", 1, 1);

      db.prepare(
        `
          INSERT INTO tasks (
            id, project_id, title, description, status, task_type, priority, project_path, result,
            workflow_pack_key, workflow_meta_json, created_at, started_at, updated_at, completed_at, source_task_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-blocked",
        "project-1",
        "Blocked review task",
        "Fix gate issues",
        "review",
        "feature",
        1,
        projectPath,
        "Waiting on feedback",
        "development",
        JSON.stringify({
          development_handoff: {
            state: "human_review",
            updated_at: 200,
            status_snapshot: "review",
            pending_retry: false,
            pr_gate_status: "blocked",
            pr_url: "https://github.com/acme/repo/pull/1",
            summary: "Blocked by PR feedback gate",
          },
        }),
        100,
        150,
        250,
        null,
        null,
      );
      db.prepare(
        "INSERT INTO task_run_sheets (task_id, workflow_pack_key, stage, status, summary_markdown, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "task-blocked",
        "development",
        "rework",
        "review",
        "# sheet",
        JSON.stringify({
          current_plan: { title: "Blocked review task", description: null, latest_report: null, project_path: projectPath },
          reproduction: { status: "not_recorded", evidence: [] },
          implementation: { result_summary: null, latest_report: null, diff_summary: null, log_highlights: [] },
          validation: { required_total: 0, passed: 0, failed: 0, pending: 0, blocked_review: false, pending_retry: false, recent_runs: [], artifacts: [] },
          review_checklist: {
            entered_review: true,
            blocked_review: false,
            waiting_on_subtasks: false,
            waiting_on_child_reviews: false,
            pending_retry: false,
            merge_status: "not_started",
            pr_feedback_gate: {
              applicable: true,
              status: "blocked",
              pr_url: "https://github.com/acme/repo/pull/1",
              unresolved_thread_count: 1,
              change_requests_count: 1,
              failing_check_count: 0,
              pending_check_count: 0,
              ignored_check_count: 0,
              ignored_check_names: [],
              blocking_reasons: ["Unresolved review thread"],
              checked_at: 250,
            },
          },
          handoff: { status: "review", summary: "Blocked by PR feedback gate" },
          timeline: { created_at: 100, started_at: 150, review_entered_at: 200, completed_at: null, updated_at: 250 },
        }),
        100,
        250,
      );
      db.prepare(
        "INSERT INTO task_quality_runs (id, task_id, quality_item_id, run_type, name, status, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "run-blocked",
        "task-blocked",
        null,
        "system",
        "github_pr_feedback_gate",
        "failed",
        "Blocked by unresolved feedback",
        JSON.stringify({
          applicable: true,
          pr_url: "https://github.com/acme/repo/pull/1",
          ignored_check_count: 2,
          ignored_check_names: ["optional / preview", "preview / deploy"],
        }),
        300,
      );

      db.prepare(
        `
          INSERT INTO tasks (
            id, project_id, title, description, status, task_type, priority, project_path, result,
            workflow_pack_key, workflow_meta_json, created_at, started_at, updated_at, completed_at, source_task_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-queued",
        "project-1",
        "Queued development task",
        "Still pending",
        "pending",
        "feature",
        2,
        projectPath,
        null,
        "development",
        null,
        110,
        null,
        210,
        null,
        null,
      );

      db.prepare(
        `
          INSERT INTO tasks (
            id, project_id, title, description, status, task_type, priority, project_path, result,
            workflow_pack_key, workflow_meta_json, created_at, started_at, updated_at, completed_at, source_task_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-missing",
        "project-1",
        "Missing run sheet task",
        "Already executing but missing persisted sheet",
        "review",
        "feature",
        3,
        projectPath,
        null,
        "development",
        null,
        120,
        160,
        260,
        null,
        null,
      );
      db.prepare(
        "INSERT INTO task_quality_runs (id, task_id, quality_item_id, run_type, name, status, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "run-passed",
        "task-missing",
        null,
        "system",
        "github_pr_feedback_gate",
        "passed",
        "Gate passed",
        JSON.stringify({
          applicable: true,
          ignored_check_count: 1,
          ignored_check_names: ["optional / smoke"],
        }),
        310,
      );

      db.prepare(
        `
          INSERT INTO tasks (
            id, project_id, title, description, status, task_type, priority, project_path, result,
            workflow_pack_key, workflow_meta_json, created_at, started_at, updated_at, completed_at, source_task_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-report",
        "project-1",
        "Report task",
        "Should be ignored",
        "done",
        "report",
        4,
        projectPath,
        null,
        "report",
        null,
        90,
        95,
        205,
        220,
        null,
      );

      const handler = routes.get("GET /api/projects/:id");
      const res = createFakeResponse();
      handler?.({ params: { id: "project-1" } }, res);

      expect(res.statusCode).toBe(200);
      const health = (res.payload as any).development_workflow_health;
      expect(health.coverage).toEqual({
        root_task_total: 3,
        stored_run_sheet_count: 1,
        synthetic_queued_count: 1,
        missing_persisted_run_sheet_count: 1,
      });
      expect(health.contract_status.preview_pack_key).toBe("development");
      expect(health.contract_status.override_applied).toBe(true);
      expect(health.handoff_states).toEqual(
        expect.arrayContaining([
          { state: "human_review", count: 1 },
          { state: "queued", count: 1 },
        ]),
      );
      expect(health.pr_gate).toEqual({
        blocked_count: 1,
        passed_count: 1,
        skipped_count: 0,
        never_checked_count: 1,
        ignored_optional_checks_total: 3,
      });
      expect(health.attention_tasks.map((task: any) => task.task_id)).toEqual([
        "task-blocked",
        "task-missing",
      ]);
      expect(health.attention_tasks[0]).toMatchObject({
        handoff_state: "human_review",
        run_sheet_stage: "rework",
        pr_gate_status: "blocked",
        pending_retry: false,
      });
    } finally {
      db.close();
    }
  });

  it("GET /api/projects/:id exposes last-known-good contract status when workflow file breaks", () => {
    const { db, routes } = createHarness();
    const projectPath = createTempDir("claw-project-health-cache-");
    const workflowFile = path.join(projectPath, "WORKFLOW.md");
    fs.writeFileSync(
      workflowFile,
      ["---", "defaultWorkflowPackKey: development", "---", "", "Follow the previous stable policy."].join("\n"),
      "utf8",
    );

    try {
      db.prepare(
        "INSERT INTO projects (id, name, project_path, core_goal, default_pack_key, assignment_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("project-2", "Project", projectPath, "Goal", "development", "auto", 1, 1);
      db.prepare(
        `
          INSERT INTO tasks (
            id, project_id, title, description, status, task_type, priority, project_path, result,
            workflow_pack_key, workflow_meta_json, created_at, started_at, updated_at, completed_at, source_task_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-dev",
        "project-2",
        "Healthy development task",
        "Stable task",
        "pending",
        "feature",
        1,
        projectPath,
        null,
        "development",
        null,
        100,
        null,
        120,
        null,
        null,
      );

      const handler = routes.get("GET /api/projects/:id");
      const firstRes = createFakeResponse();
      handler?.({ params: { id: "project-2" } }, firstRes);
      expect((firstRes.payload as any).development_workflow_health.contract_status.last_known_good_applied).toBe(false);

      fs.writeFileSync(workflowFile, "---\ndefaultWorkflowPackKey: [\n---\n", "utf8");

      const secondRes = createFakeResponse();
      handler?.({ params: { id: "project-2" } }, secondRes);

      expect(secondRes.statusCode).toBe(200);
      const contractStatus = (secondRes.payload as any).development_workflow_health.contract_status;
      expect(contractStatus.last_known_good_applied).toBe(true);
      expect(contractStatus.last_known_good_cached_at).toBe(1700000000000);
      expect(contractStatus.warnings).toContain("last-known-good applied from settings cache");
    } finally {
      db.close();
    }
  });
});
