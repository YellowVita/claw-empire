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

  it("treats collaborating parent tasks as active during delegated batch ack", () => {
    vi.useFakeTimers();
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        department_id TEXT,
        project_id TEXT,
        status TEXT,
        priority INTEGER,
        task_type TEXT,
        workflow_pack_key TEXT,
        project_path TEXT,
        source_task_id TEXT,
        assigned_agent_id TEXT,
        started_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        title TEXT,
        description TEXT,
        status TEXT,
        assigned_agent_id TEXT,
        blocked_reason TEXT,
        orchestration_phase TEXT,
        cli_tool_use_id TEXT,
        created_at INTEGER,
        completed_at INTEGER,
        target_department_id TEXT,
        delegated_task_id TEXT
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT,
        department_id TEXT,
        role TEXT,
        cli_provider TEXT,
        oauth_account_id TEXT,
        api_provider_id TEXT,
        api_model TEXT,
        cli_model TEXT,
        cli_reasoning_level TEXT,
        status TEXT,
        current_task_id TEXT
      );
    `);

    db.prepare(
      "INSERT INTO tasks (id, title, description, department_id, project_id, status, priority, task_type, workflow_pack_key, project_path, source_task_id, assigned_agent_id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "task-1",
      "Parent task",
      "desc",
      "planning",
      null,
      "collaborating",
      1,
      "general",
      "development",
      "C:/workspace/project",
      null,
      "origin-lead",
      null,
      1,
      1,
    );
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, description, status, assigned_agent_id, blocked_reason, orchestration_phase, cli_tool_use_id, created_at, completed_at, target_department_id, delegated_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "sub-1",
      "task-1",
      "QA validation",
      null,
      "blocked",
      "qa-worker",
      "QA 협업 대기",
      "foreign_collab",
      null,
      1,
      null,
      "qa",
      null,
    );
    db.prepare(
      "INSERT INTO agents (id, name, department_id, role, cli_provider, oauth_account_id, api_provider_id, api_model, cli_model, cli_reasoning_level, status, current_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("origin-lead", "Origin Lead", "planning", "team_leader", "codex", null, null, null, null, null, "idle", null);
    db.prepare(
      "INSERT INTO agents (id, name, department_id, role, cli_provider, oauth_account_id, api_provider_id, api_model, cli_model, cli_reasoning_level, status, current_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("qa-lead", "QA Lead", "qa", "team_leader", "codex", null, null, null, null, null, "idle", null);
    db.prepare(
      "INSERT INTO agents (id, name, department_id, role, cli_provider, oauth_account_id, api_provider_id, api_model, cli_model, cli_reasoning_level, status, current_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("qa-worker", "QA Worker", "qa", "senior", "codex", null, null, null, null, null, "idle", null);

    const appendTaskLog = vi.fn();
    const spawnCliAgent = vi.fn(() => ({ on: vi.fn() }));

    const batch = createSubtaskDelegationBatch({
      db,
      l: (ko, en, ja = en, zh = en) => ({ ko, en, ja, zh }),
      pickL: (pool, lang) => pool[lang]?.[0] ?? pool.ko[0],
      resolveLang: () => "ko",
      getDeptName: (deptId) => (deptId === "qa" ? "QA팀" : "기획팀"),
      getAgentDisplayName: (agent) => agent.name,
      findTeamLeader: (deptId) => {
        if (deptId === "planning") return { id: "origin-lead", name: "Origin Lead", department_id: "planning", role: "team_leader", status: "idle" } as any;
        if (deptId === "qa") return { id: "qa-lead", name: "QA Lead", department_id: "qa", role: "team_leader", cli_provider: "codex", status: "idle" } as any;
        return null;
      },
      findBestSubordinate: (deptId) =>
        deptId === "qa"
          ? ({ id: "qa-worker", name: "QA Worker", department_id: "qa", role: "senior", cli_provider: "codex", status: "idle" } as any)
          : null,
      nowMs: () => 100,
      broadcast: vi.fn(),
      notifyCeo: vi.fn(),
      sendAgentMessage: vi.fn(),
      appendTaskLog,
      recordTaskCreationAudit: vi.fn(),
      resolveProjectPath: () => "C:/workspace/project",
      createWorktree: () => ({
        success: true,
        worktreePath: "C:/workspace/project/.climpire-worktrees/task-2",
        branchName: "climpire/task2",
        projectPath: "C:/workspace/project",
      }),
      logsDir: "C:/logs",
      ensureTaskExecutionSession: () => ({ sessionId: "s1", agentId: "qa-worker", provider: "codex" }),
      ensureClaudeMd: vi.fn(),
      getProviderModelConfig: () => ({}),
      spawnCliAgent,
      getNextHttpAgentPid: () => 1,
      launchApiProviderAgent: vi.fn(),
      launchHttpAgent: vi.fn(),
      startProgressTimer: vi.fn(),
      subtaskDelegationCallbacks: new Map(),
      delegatedTaskToSubtask: new Map(),
      maybeNotifyAllSubtasksComplete: vi.fn(),
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
          status: "blocked",
          assigned_agent_id: "qa-worker",
          blocked_reason: "QA 협업 대기",
          orchestration_phase: "foreign_collab",
          cli_tool_use_id: null,
          created_at: 1,
          completed_at: null,
          target_department_id: "qa",
          delegated_task_id: null,
        },
      ] as any,
      0,
      1,
      {
        id: "task-1",
        title: "Parent task",
        description: "desc",
        project_id: null,
        project_path: "C:/workspace/project",
        department_id: "planning",
        workflow_pack_key: "development",
      },
    );

    vi.runAllTimers();

    const updated = db.prepare("SELECT status, blocked_reason, delegated_task_id FROM subtasks WHERE id = ?").get("sub-1") as {
      status: string;
      blocked_reason: string | null;
      delegated_task_id: string | null;
    };

    expect(updated.status).toBe("in_progress");
    expect(updated.blocked_reason).toBeNull();
    expect(updated.delegated_task_id).toBeTruthy();
    expect(spawnCliAgent).toHaveBeenCalledTimes(1);
    expect(appendTaskLog).not.toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("parent task is not active anymore"),
    );

    vi.useRealTimers();
  });
});
