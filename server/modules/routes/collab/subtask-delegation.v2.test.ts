import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delegateSubtaskBatch = vi.fn();

vi.mock("./subtask-delegation-batch.ts", () => ({
  createSubtaskDelegationBatch: () => ({
    delegateSubtaskBatch,
  }),
}));

import { initializeSubtaskDelegation } from "./subtask-delegation.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      status TEXT,
      project_id TEXT,
      project_path TEXT,
      department_id TEXT,
      workflow_pack_key TEXT,
      source_task_id TEXT,
      assigned_agent_id TEXT,
      orchestration_version INTEGER,
      orchestration_stage TEXT,
      updated_at INTEGER
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      title TEXT,
      description TEXT,
      status TEXT,
      created_at INTEGER,
      target_department_id TEXT,
      delegated_task_id TEXT,
      blocked_reason TEXT,
      assigned_agent_id TEXT,
      orchestration_phase TEXT
    );
    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      kind TEXT,
      message TEXT,
      created_at INTEGER
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT,
      status TEXT,
      current_task_id TEXT,
      department_id TEXT
    );
  `);
  db.prepare(
    "INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id) VALUES ('planning-1', 'Clio', '클리오', 'idle', NULL, 'planning')",
  ).run();
  return db;
}

function createDelegationTools(db: DatabaseSync) {
  const appendTaskLog = vi.fn();
  const startTaskExecutionForAgent = vi.fn();
  const tools = initializeSubtaskDelegation({
    db,
    l: (ko, en, ja = en, zh = en) => ({ ko, en, ja, zh }),
    pickL: (pool, lang) => pool[lang]?.[0] ?? pool.ko[0],
    resolveLang: () => "ko",
    getPreferredLanguage: () => "ko",
    getDeptName: (deptId: string) => deptId,
    getDeptRoleConstraint: () => "role",
    getRecentConversationContext: () => "",
    getAgentDisplayName: (agent: { name?: string }) => agent.name ?? "agent",
    buildTaskExecutionPrompt: (parts: string[]) => parts.join("\n"),
    hasExplicitWarningFixRequest: () => false,
    delegatedTaskToSubtask: new Map(),
    subtaskDelegationCallbacks: new Map(),
    subtaskDelegationDispatchInFlight: new Set(),
    subtaskDelegationCompletionNoticeSent: new Set(),
    notifyCeo: vi.fn(),
    sendAgentMessage: vi.fn(),
    appendTaskLog,
    finishReview: vi.fn(),
    findTeamLeader: vi.fn(),
    findBestSubordinate: vi.fn(),
    nowMs: () => 1_000,
    broadcast: vi.fn(),
    handleTaskRunComplete: vi.fn(),
    stopRequestedTasks: new Set(),
    stopRequestModeByTask: new Map(),
    recordTaskCreationAudit: vi.fn(),
    resolveProjectPath: () => "C:/workspace/project",
    createWorktree: vi.fn(),
    logsDir: "C:/logs",
    ensureTaskExecutionSession: () => ({ sessionId: "s1", agentId: "a1", provider: "codex" }),
    ensureClaudeMd: vi.fn(),
    getProviderModelConfig: () => ({}),
    spawnCliAgent: vi.fn(),
    getNextHttpAgentPid: () => 1,
    launchApiProviderAgent: vi.fn(),
    launchHttpAgent: vi.fn(),
    startProgressTimer: vi.fn(),
    startTaskExecutionForAgent,
    activeProcesses: new Map(),
  });

  return { tools, appendTaskLog, startTaskExecutionForAgent };
}

function insertTask(
  db: DatabaseSync,
  row: {
    id: string;
    status: string;
    workflow_pack_key?: string | null;
    source_task_id?: string | null;
    orchestration_version?: number | null;
    orchestration_stage?: string | null;
    assigned_agent_id?: string | null;
  },
): void {
  db.prepare(
    `
      INSERT INTO tasks (
        id, title, description, status, project_id, project_path, department_id, workflow_pack_key,
        source_task_id, assigned_agent_id, orchestration_version, orchestration_stage
      )
      VALUES (?, 'Parent task', 'desc', ?, NULL, 'C:/workspace/project', 'planning', ?, ?, ?, ?, ?)
    `,
  ).run(
    row.id,
    row.status,
    row.workflow_pack_key ?? "development",
    row.source_task_id ?? null,
    row.assigned_agent_id ?? "planning-1",
    row.orchestration_version ?? null,
    row.orchestration_stage ?? null,
  );
}

function insertSubtask(
  db: DatabaseSync,
  row: {
    id: string;
    task_id: string;
    title: string;
    status: string;
    created_at: number;
    target_department_id?: string | null;
    blocked_reason?: string | null;
    orchestration_phase?: string | null;
    delegated_task_id?: string | null;
  },
): void {
  db.prepare(
    `
      INSERT INTO subtasks (
        id, task_id, title, description, status, created_at, target_department_id, delegated_task_id,
        blocked_reason, assigned_agent_id, orchestration_phase
      )
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)
    `,
  ).run(
    row.id,
    row.task_id,
    row.title,
    row.status,
    row.created_at,
    row.target_department_id ?? null,
    row.delegated_task_id ?? null,
    row.blocked_reason ?? null,
    row.orchestration_phase ?? null,
  );
}

describe("initializeSubtaskDelegation V2", () => {
  beforeEach(() => {
    delegateSubtaskBatch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("foreign_collab 단계에서는 최대 5개 부서만 먼저 실행한다", () => {
    const db = setupDb();
    try {
      insertTask(db, {
        id: "task-1",
        status: "collaborating",
        orchestration_version: 2,
        orchestration_stage: "foreign_collab",
      });
      insertSubtask(db, { id: "st-qa", task_id: "task-1", title: "QA batch", status: "pending", created_at: 1, target_department_id: "qa", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "st-design", task_id: "task-1", title: "Design batch", status: "pending", created_at: 2, target_department_id: "design", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "st-dev", task_id: "task-1", title: "Dev batch", status: "pending", created_at: 3, target_department_id: "dev", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "st-ops", task_id: "task-1", title: "Ops batch", status: "pending", created_at: 4, target_department_id: "operations", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "st-sec", task_id: "task-1", title: "DevSecOps batch", status: "pending", created_at: 5, target_department_id: "devsecops", orchestration_phase: "foreign_collab" });

      const { tools } = createDelegationTools(db);
      tools.processSubtaskDelegations("task-1");

      expect(delegateSubtaskBatch).toHaveBeenCalledTimes(5);
      const launchedDeptIds = delegateSubtaskBatch.mock.calls.map((call) => call[0]?.[0]?.target_department_id);
      expect(new Set(launchedDeptIds).size).toBe(5);
    } finally {
      db.close();
    }
  });

  it("review 단계 검토보완 foreign_collab 서브태스크도 최대 5개 부서까지 위임한다", () => {
    const db = setupDb();
    try {
      insertTask(db, {
        id: "task-review",
        status: "review",
        orchestration_version: 2,
        orchestration_stage: "review",
      });
      insertSubtask(db, { id: "review-dev", task_id: "task-review", title: "[검토보완] 개발 보완", status: "blocked", created_at: 1, target_department_id: "dev", blocked_reason: "개발팀 협업 대기", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "review-design", task_id: "task-review", title: "[검토보완] 디자인 보완", status: "blocked", created_at: 2, target_department_id: "design", blocked_reason: "디자인팀 협업 대기", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "review-qa", task_id: "task-review", title: "[검토보완] QA 보완", status: "blocked", created_at: 3, target_department_id: "qa", blocked_reason: "품질관리팀 협업 대기", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "review-ops", task_id: "task-review", title: "[검토보완] 운영 보완", status: "blocked", created_at: 4, target_department_id: "operations", blocked_reason: "운영팀 협업 대기", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "review-sec", task_id: "task-review", title: "[검토보완] 보안 보완", status: "blocked", created_at: 5, target_department_id: "devsecops", blocked_reason: "보안팀 협업 대기", orchestration_phase: "foreign_collab" });

      const { tools } = createDelegationTools(db);
      tools.processSubtaskDelegations("task-review");

      expect(delegateSubtaskBatch).toHaveBeenCalledTimes(5);
      const launchedDeptIds = delegateSubtaskBatch.mock.calls.map((call) => call[0]?.[0]?.target_department_id);
      expect(new Set(launchedDeptIds).size).toBe(5);
    } finally {
      db.close();
    }
  });

  it("legacy development root task는 owner_prep blocker가 남아 있으면 owner_prep으로만 승격한다", () => {
    const db = setupDb();
    try {
      insertTask(db, { id: "legacy-owner-prep", status: "in_progress" });
      insertSubtask(db, { id: "prep-1", task_id: "legacy-owner-prep", title: "준비 체크리스트", status: "pending", created_at: 1, orchestration_phase: "owner_prep" });
      insertSubtask(db, { id: "foreign-1", task_id: "legacy-owner-prep", title: "QA 배치", status: "pending", created_at: 2, target_department_id: "qa", orchestration_phase: "foreign_collab" });

      const { tools } = createDelegationTools(db);
      tools.processSubtaskDelegations("legacy-owner-prep");

      const task = db.prepare("SELECT orchestration_version, orchestration_stage FROM tasks WHERE id = ?").get("legacy-owner-prep") as {
        orchestration_version: number | null;
        orchestration_stage: string | null;
      };
      expect(task).toEqual({
        orchestration_version: 2,
        orchestration_stage: "owner_prep",
      });
      expect(delegateSubtaskBatch).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("legacy development root task는 owner_prep blocker가 없으면 foreign_collab으로 승격한다", () => {
    const db = setupDb();
    try {
      insertTask(db, { id: "legacy-foreign", status: "planned" });
      insertSubtask(db, { id: "foreign-1", task_id: "legacy-foreign", title: "QA 배치", status: "pending", created_at: 1, target_department_id: "qa", orchestration_phase: "foreign_collab" });
      insertSubtask(db, { id: "owner-integrate-1", task_id: "legacy-foreign", title: "통합 정리", status: "pending", created_at: 2, orchestration_phase: "owner_integrate" });

      const { tools } = createDelegationTools(db);
      tools.processSubtaskDelegations("legacy-foreign");

      const task = db.prepare("SELECT orchestration_version, orchestration_stage FROM tasks WHERE id = ?").get("legacy-foreign") as {
        orchestration_version: number | null;
        orchestration_stage: string | null;
      };
      expect(task).toEqual({
        orchestration_version: 2,
        orchestration_stage: "foreign_collab",
      });
      expect(delegateSubtaskBatch).toHaveBeenCalledTimes(1);
      expect(delegateSubtaskBatch.mock.calls[0]?.[0]?.[0]?.target_department_id).toBe("qa");
    } finally {
      db.close();
    }
  });

  it("legacy development root task가 review 상태면 review stage로 승격한다", () => {
    const db = setupDb();
    try {
      insertTask(db, { id: "legacy-review", status: "review" });
      insertSubtask(db, { id: "review-dev", task_id: "legacy-review", title: "[검토보완] 개발 보완", status: "blocked", created_at: 1, target_department_id: "dev", blocked_reason: "개발팀 협업 대기", orchestration_phase: "foreign_collab" });

      const { tools } = createDelegationTools(db);
      tools.processSubtaskDelegations("legacy-review");

      const task = db.prepare("SELECT orchestration_version, orchestration_stage FROM tasks WHERE id = ?").get("legacy-review") as {
        orchestration_version: number | null;
        orchestration_stage: string | null;
      };
      expect(task).toEqual({
        orchestration_version: 2,
        orchestration_stage: "review",
      });
      expect(delegateSubtaskBatch).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("legacy development root task에 owner_integrate subtask만 남으면 owner_integrate로 승격한다", () => {
    const db = setupDb();
    try {
      insertTask(db, { id: "legacy-owner-integrate", status: "collaborating" });
      insertSubtask(db, { id: "owner-integrate-1", task_id: "legacy-owner-integrate", title: "통합 정리", status: "pending", created_at: 1, orchestration_phase: "owner_integrate" });

      const { tools, startTaskExecutionForAgent } = createDelegationTools(db);
      tools.processSubtaskDelegations("legacy-owner-integrate");

      const task = db.prepare("SELECT orchestration_version, orchestration_stage FROM tasks WHERE id = ?").get("legacy-owner-integrate") as {
        orchestration_version: number | null;
        orchestration_stage: string | null;
      };
      expect(task).toEqual({
        orchestration_version: 2,
        orchestration_stage: "owner_integrate",
      });
      expect(delegateSubtaskBatch).not.toHaveBeenCalled();
      expect(startTaskExecutionForAgent).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("non-development task, child task, 이미 V2인 task는 lazy migration 대상이 아니다", () => {
    const db = setupDb();
    try {
      insertTask(db, { id: "report-root", status: "planned", workflow_pack_key: "report" });
      insertSubtask(db, { id: "report-foreign", task_id: "report-root", title: "Report QA", status: "pending", created_at: 1, target_department_id: "qa", orchestration_phase: "foreign_collab" });

      insertTask(db, { id: "dev-child", status: "planned", source_task_id: "parent-1" });
      insertSubtask(db, { id: "child-foreign", task_id: "dev-child", title: "Child QA", status: "pending", created_at: 2, target_department_id: "qa", orchestration_phase: "foreign_collab" });

      insertTask(db, { id: "dev-v2", status: "collaborating", orchestration_version: 2, orchestration_stage: "foreign_collab" });
      insertSubtask(db, { id: "v2-foreign", task_id: "dev-v2", title: "V2 QA", status: "pending", created_at: 3, target_department_id: "qa", orchestration_phase: "foreign_collab" });

      const { tools } = createDelegationTools(db);
      tools.processSubtaskDelegations("report-root");
      tools.processSubtaskDelegations("dev-child");
      tools.processSubtaskDelegations("dev-v2");

      const reportRoot = db.prepare("SELECT orchestration_version, orchestration_stage FROM tasks WHERE id = ?").get("report-root") as {
        orchestration_version: number | null;
        orchestration_stage: string | null;
      };
      const devChild = db.prepare("SELECT orchestration_version, orchestration_stage FROM tasks WHERE id = ?").get("dev-child") as {
        orchestration_version: number | null;
        orchestration_stage: string | null;
      };
      const devV2 = db.prepare("SELECT orchestration_version, orchestration_stage FROM tasks WHERE id = ?").get("dev-v2") as {
        orchestration_version: number | null;
        orchestration_stage: string | null;
      };

      expect(reportRoot).toEqual({ orchestration_version: null, orchestration_stage: null });
      expect(devChild).toEqual({ orchestration_version: null, orchestration_stage: null });
      expect(devV2).toEqual({ orchestration_version: 2, orchestration_stage: "foreign_collab" });
      expect(delegateSubtaskBatch).toHaveBeenCalledTimes(3);
    } finally {
      db.close();
    }
  });
});
