import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delegateSubtaskBatch = vi.fn();

vi.mock("./subtask-delegation-batch.ts", () => ({
  createSubtaskDelegationBatch: () => ({
    delegateSubtaskBatch,
  }),
}));

import { initializeSubtaskDelegation } from "./subtask-delegation.ts";

describe("initializeSubtaskDelegation V2", () => {
  beforeEach(() => {
    delegateSubtaskBatch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("foreign_collab 단계에서는 최대 2개 부서만 먼저 실행한다", () => {
    const db = new DatabaseSync(":memory:");
    try {
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
          orchestration_stage TEXT
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
        `
          INSERT INTO tasks (
            id, title, description, status, project_id, project_path, department_id, workflow_pack_key,
            source_task_id, assigned_agent_id, orchestration_version, orchestration_stage
          )
          VALUES ('task-1', 'Parent task', 'desc', 'collaborating', NULL, 'C:/workspace/project', 'planning', 'development', NULL, 'planning-1', 2, 'foreign_collab')
        `,
      ).run();

      const insertSubtask = db.prepare(`
        INSERT INTO subtasks (
          id, task_id, title, description, status, created_at, target_department_id, delegated_task_id,
          blocked_reason, assigned_agent_id, orchestration_phase
        )
        VALUES (?, 'task-1', ?, NULL, 'pending', ?, ?, NULL, NULL, NULL, 'foreign_collab')
      `);
      insertSubtask.run("st-qa", "QA batch", 1, "qa");
      insertSubtask.run("st-design", "Design batch", 2, "design");
      insertSubtask.run("st-dev", "Dev batch", 3, "dev");

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
        appendTaskLog: vi.fn(),
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
        startTaskExecutionForAgent: vi.fn(),
        activeProcesses: new Map(),
      });

      tools.processSubtaskDelegations("task-1");

      expect(delegateSubtaskBatch).toHaveBeenCalledTimes(2);
      const firstQueue = delegateSubtaskBatch.mock.calls[0]?.[0] ?? [];
      const secondQueue = delegateSubtaskBatch.mock.calls[1]?.[0] ?? [];
      const launchedDeptIds = [firstQueue[0]?.target_department_id, secondQueue[0]?.target_department_id];
      expect(new Set(launchedDeptIds).size).toBe(2);
      expect(launchedDeptIds.every((deptId) => ["qa", "design", "dev"].includes(String(deptId ?? "")))).toBe(true);
    } finally {
      db.close();
    }
  });
});
