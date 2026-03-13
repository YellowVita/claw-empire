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
      description TEXT,
      assigned_agent_id TEXT,
      department_id TEXT,
      workflow_pack_key TEXT,
      project_id TEXT,
      orchestration_version INTEGER,
      orchestration_stage TEXT
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      assigned_agent_id TEXT,
      cli_tool_use_id TEXT,
      target_department_id TEXT,
      blocked_reason TEXT,
      orchestration_phase TEXT,
      created_at INTEGER
    );
  `);

  db.prepare("INSERT INTO departments (id, name, name_ko) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)").run(
    "planning",
    "Planning",
    "기획팀",
    "qa",
    "QA/QC",
    "품질관리팀",
    "dev",
    "Development",
    "개발팀",
  );
  db.prepare(
    "INSERT INTO agents (id, department_id, workflow_pack_key, status, current_task_id, cli_provider, oauth_account_id, role, stats_tasks_done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("qa-lead", "qa", "development", "idle", null, "codex", null, "team_leader", 0, 1);
  db.prepare(
    "INSERT INTO agents (id, department_id, workflow_pack_key, status, current_task_id, cli_provider, oauth_account_id, role, stats_tasks_done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("planning-lead", "planning", "development", "idle", null, "codex", null, "team_leader", 0, 1);
  db.prepare(
    "INSERT INTO agents (id, department_id, workflow_pack_key, status, current_task_id, cli_provider, oauth_account_id, role, stats_tasks_done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("dev-lead", "dev", "development", "idle", null, "codex", null, "team_leader", 0, 1);
  db.prepare(
    "INSERT INTO tasks (id, title, description, assigned_agent_id, department_id, workflow_pack_key, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("task-1", "클리오 통합 작업", "정리 작업", "planning-lead", "planning", "development", null);
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

  it("V2 owner_prep 단계에서도 Codex spawn_agent 내부 워커의 외부 부서 승격을 막는다", () => {
    const db = setupDb();
    const appendTaskLog = vi.fn();
    try {
      db.prepare("UPDATE tasks SET orchestration_version = 2, orchestration_stage = 'owner_prep' WHERE id = ?").run(
        "task-1",
      );

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
        getDeptName: (departmentId: string) => (departmentId === "dev" ? "개발팀" : departmentId),
        pickL: (pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0],
        l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
        broadcast: vi.fn(),
        appendTaskLog,
        notifyCeo: vi.fn(),
      });

      const seeding = createSubtaskSeedingTools({
        db,
        nowMs: () => 1_000,
        broadcast: vi.fn(),
        analyzeSubtaskDepartment: routing.analyzeSubtaskDepartment,
        rerouteSubtasksByPlanningLeader: vi.fn(),
        findTeamLeader: (departmentId: string) => ({ id: `${departmentId}-lead` }),
        getDeptName: (departmentId: string) => (departmentId === "dev" ? "개발팀" : departmentId),
        getPreferredLanguage: () => "ko",
        resolveLang: () => "ko",
        l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
        pickL: (pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0],
        appendTaskLog,
        notifyCeo: vi.fn(),
      });

      const result = seeding.createSubtaskFromCli("task-1", "tool-codex", "개발팀 역할로 API를 구현하세요.", {
        source: "codex_spawn_agent",
      });

      const count = db.prepare("SELECT COUNT(*) AS cnt FROM subtasks").get() as { cnt: number };

      expect(result).toEqual({ created: false });
      expect(count.cnt).toBe(0);
      expect(appendTaskLog).toHaveBeenCalledWith(
        "task-1",
        "system",
        expect.stringContaining("V2 internal worker kept log-only"),
      );
    } finally {
      db.close();
    }
  });

  it("V2 owner_prep 단계에서도 Claude Task 내부 워커의 외부 부서 승격을 막는다", () => {
    const db = setupDb();
    const appendTaskLog = vi.fn();
    try {
      db.prepare("UPDATE tasks SET orchestration_version = 2, orchestration_stage = 'owner_prep' WHERE id = ?").run(
        "task-1",
      );

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
        appendTaskLog,
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
        appendTaskLog,
        notifyCeo: vi.fn(),
      });

      const result = seeding.createSubtaskFromCli(
        "task-1",
        "tool-claude",
        "역할: QA팀장. 개발팀 산출물을 다시 검증하세요.",
        { source: "claude_task" },
      );

      const count = db.prepare("SELECT COUNT(*) AS cnt FROM subtasks").get() as { cnt: number };

      expect(result).toEqual({ created: false });
      expect(count.cnt).toBe(0);
      expect(appendTaskLog).toHaveBeenCalledWith(
        "task-1",
        "system",
        expect.stringContaining("V2 internal worker kept log-only"),
      );
    } finally {
      db.close();
    }
  });

  it("V2 owner_prep 단계에서도 선언적 plan 기반 서브태스크 생성은 유지한다", () => {
    const db = setupDb();
    try {
      db.prepare("UPDATE tasks SET orchestration_version = 2, orchestration_stage = 'owner_prep' WHERE id = ?").run(
        "task-1",
      );

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

      const result = seeding.createSubtaskFromCli(
        "task-1",
        "tool-plan",
        "QA 검증 문서를 준비하세요.",
        { source: "http_plan" },
      );

      const created = db.prepare("SELECT status, target_department_id FROM subtasks").get() as {
        status: string;
        target_department_id: string | null;
      };

      expect(result).toEqual({ created: true });
      expect(created.status).toBe("blocked");
      expect(created.target_department_id).toBe("qa");
    } finally {
      db.close();
    }
  });

  it("비-V2 태스크에서는 기존처럼 내부 워커 기반 외부 부서 서브태스크 생성이 유지된다", () => {
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
        getDeptName: (departmentId: string) => (departmentId === "dev" ? "개발팀" : departmentId),
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
        getDeptName: (departmentId: string) => (departmentId === "dev" ? "개발팀" : departmentId),
        getPreferredLanguage: () => "ko",
        resolveLang: () => "ko",
        l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
        pickL: (pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0],
        appendTaskLog: vi.fn(),
        notifyCeo: vi.fn(),
      });

      const result = seeding.createSubtaskFromCli("task-1", "tool-v1", "개발팀 역할로 API를 구현하세요.", {
        source: "codex_spawn_agent",
      });

      const created = db.prepare("SELECT status, target_department_id, blocked_reason FROM subtasks").get() as {
        status: string;
        target_department_id: string | null;
        blocked_reason: string | null;
      };

      expect(result).toEqual({ created: true });
      expect(created.status).toBe("blocked");
      expect(created.target_department_id).toBe("dev");
      expect(created.blocked_reason).toBe("개발팀 협업 대기");
    } finally {
      db.close();
    }
  });
});

describe("seedApprovedPlanSubtasks", () => {
  it("skipPlannedMeeting 경로는 planned meeting 문구 없이 V2 phase subtasks를 생성한다", () => {
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
        getDeptName: (departmentId: string) =>
          departmentId === "qa" ? "품질관리팀" : departmentId === "dev" ? "개발팀" : "기획팀",
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
        getDeptName: (departmentId: string) =>
          departmentId === "qa" ? "품질관리팀" : departmentId === "dev" ? "개발팀" : "기획팀",
        getPreferredLanguage: () => "ko",
        resolveLang: () => "ko",
        l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
        pickL: (pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0],
        appendTaskLog: vi.fn(),
        notifyCeo: vi.fn(),
      });

      seeding.seedApprovedPlanSubtasks("task-1", "planning", ["QA 검증 문서를 준비하세요."], {
        skipPlannedMeeting: true,
      });

      const subtasks = db
        .prepare("SELECT title, description, orchestration_phase, target_department_id FROM subtasks ORDER BY created_at, title")
        .all() as Array<{
        title: string;
        description: string | null;
        orchestration_phase: string | null;
        target_department_id: string | null;
      }>;

      expect(subtasks.some((row) => row.orchestration_phase === "owner_prep")).toBe(true);
      expect(subtasks.some((row) => row.orchestration_phase === "foreign_collab")).toBe(true);
      expect(subtasks.some((row) => row.orchestration_phase === "owner_integrate")).toBe(true);
      expect(subtasks.some((row) => row.title.includes("planned meeting") || row.description?.includes("planned meeting"))).toBe(
        false,
      );
      expect(subtasks.some((row) => row.title.includes("Planned") || row.description?.includes("Planned 회의"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("meeting 경로는 기존 planned meeting 문구를 유지한다", () => {
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
        getDeptName: (departmentId: string) =>
          departmentId === "qa" ? "품질관리팀" : departmentId === "dev" ? "개발팀" : "기획팀",
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
        getDeptName: (departmentId: string) =>
          departmentId === "qa" ? "품질관리팀" : departmentId === "dev" ? "개발팀" : "기획팀",
        getPreferredLanguage: () => "ko",
        resolveLang: () => "ko",
        l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
        pickL: (pool: any, lang: string) => pool[lang]?.[0] ?? pool.ko[0],
        appendTaskLog: vi.fn(),
        notifyCeo: vi.fn(),
      });

      seeding.seedApprovedPlanSubtasks("task-1", "planning", [], { skipPlannedMeeting: false });

      const prep = db.prepare("SELECT title, description FROM subtasks WHERE orchestration_phase = 'owner_prep' LIMIT 1").get() as {
        title: string;
        description: string | null;
      };

      expect(prep.title).toContain("Planned");
      expect(prep.description).toContain("Planned 회의");
    } finally {
      db.close();
    }
  });
});
