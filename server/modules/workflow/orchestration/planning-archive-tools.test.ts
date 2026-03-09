import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { createPlanningArchiveTools } from "./planning-archive-tools.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT,
      assigned_agent_id TEXT,
      result TEXT,
      source_task_id TEXT,
      project_path TEXT,
      completed_at INTEGER,
      created_at INTEGER,
      department_id TEXT,
      project_id TEXT,
      workflow_pack_key TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT,
      department_id TEXT,
      role TEXT,
      cli_provider TEXT,
      oauth_account_id TEXT,
      status TEXT,
      current_task_id TEXT,
      stats_tasks_done INTEGER,
      created_at INTEGER,
      workflow_pack_key TEXT
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      assignment_mode TEXT
    );
    CREATE TABLE project_agents (
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_report_archives (
      id TEXT PRIMARY KEY,
      root_task_id TEXT NOT NULL UNIQUE,
      generated_by_agent_id TEXT,
      summary_markdown TEXT NOT NULL,
      source_snapshot_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
  `);
  return db;
}

describe("planning archive quality artifact capture", () => {
  it("planning archive 갱신은 report_archive artifact를 archive_id 기준으로 upsert한다", async () => {
    const db = createDb();
    try {
      db.prepare(
        "INSERT INTO tasks (id, title, description, status, assigned_agent_id, result, source_task_id, project_path, completed_at, created_at, department_id, project_id, workflow_pack_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("task-1", "Root Task", "desc", "done", "planner-1", "Root result", null, "/tmp/project", 100, 10, "planning", "project-1", "development");
      db.prepare("INSERT INTO departments (id, name, name_ko) VALUES (?, ?, ?)").run("planning", "Planning", "기획팀");
      db.prepare("INSERT INTO projects (id, assignment_mode) VALUES (?, ?)").run("project-1", "auto");
      db.prepare(
        "INSERT INTO agents (id, name, name_ko, department_id, role, cli_provider, oauth_account_id, status, current_task_id, stats_tasks_done, created_at, workflow_pack_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("planner-1", "Ari", "아리", "planning", "team_leader", "codex", null, "idle", null, 0, 1, "development");
      db.prepare(
        "INSERT INTO messages (id, task_id, content, message_type, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("msg-1", "task-1", "Team report body", "report", 100);

      const tools = createPlanningArchiveTools({
        db,
        nowMs: () => 1700000000000,
        randomUUID: () => "archive-row",
        appendTaskLog: vi.fn(),
        sendAgentMessage: vi.fn(),
        broadcast: vi.fn(),
        pickL: (pool: any) => (Array.isArray(pool?.en) ? pool.en[0] : ""),
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        resolveLang: () => "en",
        runAgentOneShot: vi.fn(async () => ({
          text: `${"# Consolidated Report\n\n"}${"A".repeat(260)}`,
        })),
        normalizeConversationReply: (text: string) => text,
        findTeamLeader: vi.fn(() => ({ id: "planner-1", name: "Ari" })),
        getDeptName: vi.fn(() => "Planning"),
        getAgentDisplayName: vi.fn(() => "Ari"),
      } as any);

      await tools.archivePlanningConsolidatedReport("task-1");
      await tools.archivePlanningConsolidatedReport("task-1");

      const artifacts = db
        .prepare("SELECT title, source, metadata_json FROM task_artifacts WHERE task_id = ?")
        .all("task-1") as Array<{ title: string; source: string; metadata_json: string }>;
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.source).toBe("report_archive");
      expect(JSON.parse(String(artifacts[0]?.metadata_json ?? "{}"))).toMatchObject({
        archive_id: "task-1",
        has_snapshot: true,
      });
    } finally {
      db.close();
    }
  });
});
