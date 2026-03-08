import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeSubtaskDelegation } from "./subtask-delegation.ts";

describe("initializeSubtaskDelegation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries foreign delegation when origin subtasks are still unfinished", async () => {
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
        assigned_agent_id TEXT
      );
    `);

    db.prepare(
      "INSERT INTO tasks (id, title, description, status, project_id, project_path, department_id, workflow_pack_key, source_task_id, assigned_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("task-1", "Parent task", "desc", "in_progress", null, "C:/workspace/project", "dev", "development", null, "dev-1");
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, description, status, created_at, target_department_id, delegated_task_id, blocked_reason, assigned_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("own-1", "task-1", "owner work", null, "pending", 1, null, null, null, "dev-1");
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, description, status, created_at, target_department_id, delegated_task_id, blocked_reason, assigned_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("foreign-1", "task-1", "qa work", null, "pending", 2, "qa", null, null, null);

    const appendTaskLog = vi.fn();
    const notifyCeo = vi.fn();

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
      notifyCeo,
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

    expect(appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("Subtask delegation deferred"),
    );
    expect(appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("Subtask delegation retry scheduled"),
    );

    await vi.advanceTimersByTimeAsync(15_000);

    const deferredLogs = appendTaskLog.mock.calls.filter(
      ([taskId, kind, message]) =>
        taskId === "task-1" &&
        kind === "system" &&
        typeof message === "string" &&
        message.includes("Subtask delegation deferred"),
    );

    expect(deferredLogs.length).toBeGreaterThanOrEqual(2);
    expect(notifyCeo).toHaveBeenCalledTimes(1);
  });
});
