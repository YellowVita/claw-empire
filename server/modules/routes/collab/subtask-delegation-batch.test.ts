import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { createSubtaskDelegationBatch } from "./subtask-delegation-batch.ts";

describe("createSubtaskDelegationBatch", () => {
  it("fails fast when a required delegation dependency is missing", () => {
    const db = new DatabaseSync(":memory:");

    expect(() =>
      createSubtaskDelegationBatch({
        db,
        l: (ko, en, ja = en, zh = en) => ({ ko, en, ja, zh }),
        pickL: (pool, lang) => pool[lang]?.[0] ?? pool.ko[0],
        resolveLang: () => "ko",
        getDeptName: () => "QA팀",
        getAgentDisplayName: () => "Agent",
        findTeamLeader: undefined as any,
        findBestSubordinate: () => null,
        nowMs: () => 100,
        broadcast: vi.fn(),
        notifyCeo: vi.fn(),
        sendAgentMessage: vi.fn(),
        appendTaskLog: vi.fn(),
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
        subtaskDelegationCallbacks: new Map(),
        delegatedTaskToSubtask: new Map(),
        maybeNotifyAllSubtasksComplete: vi.fn(),
        finalizeDelegatedSubtasks: vi.fn(),
        buildSubtaskDelegationPrompt: () => "prompt",
      }),
    ).toThrow("subtask_delegation_dependency_missing: findTeamLeader");
  });

  it("marks foreign subtasks blocked when no scoped team leader exists", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        title TEXT,
        status TEXT,
        blocked_reason TEXT,
        completed_at INTEGER,
        delegated_task_id TEXT,
        target_department_id TEXT,
        created_at INTEGER
      );
    `);

    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, status, blocked_reason, completed_at, delegated_task_id, target_department_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sub-1", "task-1", "QA validation", "pending", null, null, null, "qa", 1);

    const notifyCeo = vi.fn();
    const appendTaskLog = vi.fn();
    const maybeNotifyAllSubtasksComplete = vi.fn();
    const onBatchDone = vi.fn();

    const batch = createSubtaskDelegationBatch({
      db,
      l: (ko, en, ja = en, zh = en) => ({ ko, en, ja, zh }),
      pickL: (pool, lang) => pool[lang]?.[0] ?? pool.ko[0],
      resolveLang: () => "ko",
      getDeptName: () => "QA팀",
      getAgentDisplayName: () => "Agent",
      findTeamLeader: () => null,
      findBestSubordinate: () => null,
      nowMs: () => 100,
      broadcast: vi.fn(),
      notifyCeo,
      sendAgentMessage: vi.fn(),
      appendTaskLog,
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
      subtaskDelegationCallbacks: new Map(),
      delegatedTaskToSubtask: new Map(),
      maybeNotifyAllSubtasksComplete,
      finalizeDelegatedSubtasks: vi.fn(),
      buildSubtaskDelegationPrompt: () => "prompt",
    });

    batch.delegateSubtaskBatch(
      [
        {
          id: "sub-1",
          task_id: "task-1",
          title: "QA validation",
          description: null,
          status: "pending",
          created_at: 1,
          target_department_id: "qa",
          delegated_task_id: null,
          blocked_reason: null,
        },
      ],
      0,
      1,
      {
        id: "task-1",
        title: "Parent task",
        description: "desc",
        project_id: null,
        project_path: "C:/workspace/project",
        department_id: "dev",
        workflow_pack_key: "development",
      },
      onBatchDone,
    );

    const updated = db.prepare("SELECT status, blocked_reason, completed_at FROM subtasks WHERE id = ?").get("sub-1") as {
      status: string;
      blocked_reason: string | null;
      completed_at: number | null;
    };

    expect(updated.status).toBe("blocked");
    expect(updated.completed_at).toBeNull();
    expect(updated.blocked_reason).toContain("팀장");
    expect(onBatchDone).toHaveBeenCalledTimes(1);
    expect(maybeNotifyAllSubtasksComplete).not.toHaveBeenCalled();
    expect(notifyCeo).toHaveBeenCalledTimes(1);
    expect(appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("no scoped team leader found"),
    );
  });
});
