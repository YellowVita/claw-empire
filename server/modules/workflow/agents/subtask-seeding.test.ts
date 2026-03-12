import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { createSubtaskRoutingTools } from "./subtask-routing.ts";
import { createSubtaskSeedingTools } from "./subtask-seeding.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      department_id TEXT,
      workflow_pack_key TEXT,
      status TEXT,
      current_task_id TEXT,
      cli_provider TEXT,
      oauth_account_id TEXT,
      role TEXT,
      stats_tasks_done INTEGER,
      created_at INTEGER
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      assigned_agent_id TEXT,
      department_id TEXT,
      workflow_pack_key TEXT,
      project_id TEXT
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      assigned_agent_id TEXT,
      cli_tool_use_id TEXT,
      target_department_id TEXT,
      blocked_reason TEXT,
      created_at INTEGER
    );
  `);

  db.prepare("INSERT INTO departments (id, name, name_ko) VALUES (?, ?, ?), (?, ?, ?)").run(
    "planning",
    "Planning",
    "기획팀",
    "qa",
    "QA/QC",
    "품질관리팀",
  );
  db.prepare(
    "INSERT INTO agents (id, department_id, workflow_pack_key, status, current_task_id, cli_provider, oauth_account_id, role, stats_tasks_done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("qa-lead", "qa", "development", "idle", null, "codex", null, "team_leader", 0, 1);
  db.prepare(
    "INSERT INTO tasks (id, title, assigned_agent_id, department_id, workflow_pack_key, project_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("task-1", "클리오 통합 작업", "clio", "planning", "development", null);
  return db;
}

describe("createSubtaskFromCli", () => {
  it("명시 역할 힌트를 기준으로 CLI subtask를 올바른 부서와 협업 대기 상태로 생성한다", () => {
    const db = setupDb();
    try {
      const routing = createSubtaskRoutingTools({
        db,
        DEPT_KEYWORDS: {
          qa: ["qa", "테스트", "검증"],
          dev: ["개발", "구현", "코딩"],
        },
        detectTargetDepartments: () => [],
        runAgentOneShot: vi.fn(),
        resolveProjectPath: () => "C:/workspace/project",
        resolveLang: () => "ko",
        findTeamLeader: (departmentId: string) => ({ id: `${departmentId}-lead` }),
        getDeptName: (departmentId: string) => (departmentId === "qa" ? "품질관리팀" : departmentId),
        pickL: (pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0],
        l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
        broadcast: vi.fn(),
        appendTaskLog: vi.fn(),
        notifyCeo: vi.fn(),
      });

      const seeding = createSubtaskSeedingTools({
        db,
        nowMs: () => 1_000,
        broadcast: vi.fn(),
        analyzeSubtaskDepartment: routing.analyzeSubtaskDepartment,
        rerouteSubtasksByPlanningLeader: vi.fn(),
        findTeamLeader: (departmentId: string) => ({ id: `${departmentId}-lead` }),
        getDeptName: (departmentId: string) => (departmentId === "qa" ? "품질관리팀" : departmentId),
        getPreferredLanguage: () => "ko",
        resolveLang: () => "ko",
        l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
        pickL: (pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0],
        appendTaskLog: vi.fn(),
        notifyCeo: vi.fn(),
      });

      seeding.createSubtaskFromCli(
        "task-1",
        "tool-1",
        "역할: QA팀장. 이번 라운드 목표는 실제 구현 계획 보완안 작성이다. 코딩은 하지 말고 planning/doc 관점만 다뤄라.",
      );

      const created = db.prepare("SELECT status, target_department_id, blocked_reason, assigned_agent_id FROM subtasks").get() as {
        status: string;
        target_department_id: string | null;
        blocked_reason: string | null;
        assigned_agent_id: string | null;
      };

      expect(created.status).toBe("blocked");
      expect(created.target_department_id).toBe("qa");
      expect(created.blocked_reason).toBe("품질관리팀 협업 대기");
      expect(created.assigned_agent_id).toBe("qa-lead");
    } finally {
      db.close();
    }
  });
});
