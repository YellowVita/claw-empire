import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { createSubtaskRoutingTools } from "./subtask-routing.ts";

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
      description TEXT,
      status TEXT NOT NULL,
      department_id TEXT,
      assigned_agent_id TEXT,
      project_id TEXT,
      workflow_pack_key TEXT
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      blocked_reason TEXT,
      target_department_id TEXT,
      assigned_agent_id TEXT,
      delegated_task_id TEXT,
      created_at INTEGER
    );
  `);

  db.prepare("INSERT INTO departments (id, name, name_ko) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)").run(
    "dev",
    "Engineering",
    "개발팀",
    "design",
    "Design",
    "디자인팀",
    "qa",
    "QA/QC",
    "품질관리팀",
    "devsecops",
    "DevSecOps",
    "인프라보안팀",
  );

  db.prepare(
    "INSERT INTO agents (id, department_id, workflow_pack_key, status, current_task_id, cli_provider, oauth_account_id, role, stats_tasks_done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "dev-lead",
    "dev",
    "development",
    "idle",
    null,
    "codex",
    null,
    "team_leader",
    0,
    1,
    "qa-lead",
    "qa",
    "development",
    "idle",
    null,
    "codex",
    null,
    "team_leader",
    0,
    1,
    "design-lead",
    "design",
    "development",
    "idle",
    null,
    "codex",
    null,
    "team_leader",
    0,
    1,
  );

  return db;
}

function createTools(db: DatabaseSync) {
  return createSubtaskRoutingTools({
    db,
    DEPT_KEYWORDS: {
      dev: ["개발", "구현", "코딩"],
      design: ["디자인", "와이어프레임"],
      qa: ["qa", "테스트", "검증"],
      devsecops: ["인프라", "보안"],
    },
    detectTargetDepartments: () => [],
    runAgentOneShot: vi.fn(),
    resolveProjectPath: () => "C:/workspace/project",
    resolveLang: () => "ko",
    findTeamLeader: (departmentId: string) => ({ id: `${departmentId}-lead` }),
    getDeptName: (departmentId: string) =>
      ({
        dev: "개발팀",
        design: "디자인팀",
        qa: "품질관리팀",
        devsecops: "인프라보안팀",
      })[departmentId] ?? departmentId,
    pickL: (pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0],
    l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
    broadcast: vi.fn(),
    appendTaskLog: vi.fn(),
    notifyCeo: vi.fn(),
  });
}

describe("analyzeSubtaskDepartment explicit role hints", () => {
  it("QA팀장 힌트가 구현/코딩 키워드보다 우선한다", () => {
    const db = setupDb();
    try {
      const { analyzeSubtaskDepartment } = createTools(db);
      const result = analyzeSubtaskDepartment(
        "역할: QA팀장. 이번 라운드 목표는 실제 구현 계획 보완안 작성이다. 코딩은 하지 말고 planning/doc 관점만 다뤄라.",
        "planning",
      );
      expect(result).toBe("qa");
    } finally {
      db.close();
    }
  });

  it("개발/디자인/인프라보안 팀장 역할도 명시 부서로 우선 분류한다", () => {
    const db = setupDb();
    try {
      const { analyzeSubtaskDepartment } = createTools(db);
      expect(analyzeSubtaskDepartment("역할: 개발팀장. 테스트 계획까지 포함해 정리해줘", "planning")).toBe("dev");
      expect(analyzeSubtaskDepartment("역할: 디자인팀장. 구현 전 와이어프레임을 먼저 정리해줘", "planning")).toBe(
        "design",
      );
      expect(
        analyzeSubtaskDepartment("역할: 인프라보안팀장. 구현 전 배포/보안 기준을 정리해줘", "planning"),
      ).toBe("devsecops");
    } finally {
      db.close();
    }
  });
});

describe("repairExplicitRoleSubtaskRouting", () => {
  it("활성 미위임 subtask의 명시 역할 오분류를 교정한다", () => {
    const db = setupDb();
    try {
      db.prepare(
        "INSERT INTO tasks (id, title, description, status, department_id, assigned_agent_id, project_id, workflow_pack_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "task-1",
        "클리오 통합 작업",
        "문서 정리와 부서 산출물 통합",
        "in_progress",
        "planning",
        "clio",
        null,
        "development",
      );
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, status, blocked_reason, target_department_id, assigned_agent_id, delegated_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "sub-qa",
        "task-1",
        "역할: QA팀장. 실제 구현 계획 보완안을 검토하고 코딩은 하지 마라.",
        "blocked",
        "개발팀 협업 대기",
        "dev",
        "dev-lead",
        null,
        1,
        "sub-done",
        "task-1",
        "역할: QA팀장. 이미 끝난 항목",
        "done",
        "개발팀 협업 대기",
        "dev",
        "dev-lead",
        null,
        2,
        "sub-delegated",
        "task-1",
        "역할: QA팀장. 이미 위임된 항목",
        "blocked",
        "개발팀 협업 대기",
        "dev",
        "dev-lead",
        "delegated-1",
        3,
      );

      const { repairExplicitRoleSubtaskRouting } = createTools(db);
      const updated = repairExplicitRoleSubtaskRouting();

      const fixed = db
        .prepare("SELECT target_department_id, status, blocked_reason, assigned_agent_id FROM subtasks WHERE id = ?")
        .get("sub-qa") as {
        target_department_id: string | null;
        status: string;
        blocked_reason: string | null;
        assigned_agent_id: string | null;
      };
      const untouchedDone = db.prepare("SELECT target_department_id FROM subtasks WHERE id = ?").get("sub-done") as {
        target_department_id: string | null;
      };
      const untouchedDelegated = db
        .prepare("SELECT target_department_id FROM subtasks WHERE id = ?")
        .get("sub-delegated") as { target_department_id: string | null };

      expect(updated).toBe(1);
      expect(fixed.target_department_id).toBe("qa");
      expect(fixed.status).toBe("blocked");
      expect(fixed.blocked_reason).toBe("품질관리팀 협업 대기");
      expect(fixed.assigned_agent_id).toBe("qa-lead");
      expect(untouchedDone.target_department_id).toBe("dev");
      expect(untouchedDelegated.target_department_id).toBe("dev");
    } finally {
      db.close();
    }
  });
});
