import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delegateSubtaskBatch = vi.fn();

vi.mock("./subtask-delegation-batch.ts", () => ({
  createSubtaskDelegationBatch: () => ({
    delegateSubtaskBatch,
  }),
}));

import { initializeSubtaskDelegation } from "./subtask-delegation.ts";

describe("initializeSubtaskDelegation legacy phase-aware gate", () => {
  beforeEach(() => {
    delegateSubtaskBatch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches foreign delegation when only owner_integrate owner-side subtasks remain", () => {
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
          assigned_agent_id TEXT
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
        "INSERT INTO tasks (id, title, description, status, project_id, project_path, department_id, workflow_pack_key, source_task_id, assigned_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("task-1", "Parent task", "desc", "in_progress", null, "C:/workspace/project", "planning", "development", null, "planning-1");
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, description, status, created_at, target_department_id, delegated_task_id, blocked_reason, assigned_agent_id, orchestration_phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("integrate-1", "task-1", "부서 산출물 통합 및 최종 정리", null, "pending", 1, null, null, null, "planning-1", "owner_integrate");
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, description, status, created_at, target_department_id, delegated_task_id, blocked_reason, assigned_agent_id, orchestration_phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("foreign-1", "task-1", "qa work", null, "pending", 2, "qa", null, null, null, "foreign_collab");

      const appendTaskLog = vi.fn();

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
        startTaskExecutionForAgent: vi.fn(),
        activeProcesses: new Map(),
      });

      tools.processSubtaskDelegations("task-1");

      expect(delegateSubtaskBatch).toHaveBeenCalledTimes(1);
      expect(appendTaskLog).toHaveBeenCalledWith(
        "task-1",
        "system",
        expect.stringContaining("owner_integrate subtask(s) remain but do not block foreign delegation"),
      );
    } finally {
      db.close();
    }
  });
});
