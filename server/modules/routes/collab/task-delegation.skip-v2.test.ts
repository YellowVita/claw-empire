import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTaskDelegationHandler } from "./task-delegation.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      assigned_agent_id TEXT,
      project_id TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      workflow_pack_key TEXT NOT NULL,
      orchestration_version INTEGER,
      orchestration_stage TEXT,
      project_path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      current_task_id TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      core_goal TEXT,
      project_path TEXT,
      default_pack_key TEXT NOT NULL DEFAULT 'development',
      assignment_mode TEXT,
      last_used_at INTEGER,
      updated_at INTEGER
    );
  `);
  db.prepare("INSERT INTO projects (id, name, core_goal, project_path, default_pack_key, assignment_mode) VALUES (?, ?, ?, ?, ?, ?)").run(
    "project-1",
    "Demo",
    "goal",
    "C:/workspace/demo",
    "development",
    null,
  );
  db.prepare("INSERT INTO agents (id, current_task_id) VALUES (?, NULL)").run("planning-lead");
  return db;
}

describe("createTaskDelegationHandler skipPlannedMeeting V2", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("skipPlannedMeeting 경로에서도 root task를 V2 owner_prep으로 생성한다", async () => {
    const db = createDb();
    try {
      const seedApprovedPlanSubtasks = vi.fn();
      const startPlannedApprovalMeeting = vi.fn();
      const startTaskExecutionForAgent = vi.fn();

      const handleTaskDelegation = createTaskDelegationHandler({
        db: db as any,
        nowMs: () => 1_000,
        resolveLang: () => "ko",
        getDeptName: () => "기획팀",
        getRoleLabel: () => "팀장",
        detectTargetDepartments: () => [],
        findBestSubordinate: () => null,
        normalizeTextField: (value: unknown) => (typeof value === "string" ? value.trim() || null : null),
        resolveProjectFromOptions: () => ({
          id: "project-1",
          name: "Demo",
          projectPath: "C:/workspace/demo",
          coreGoal: "goal",
        }),
        buildRoundGoal: () => "round",
        resolveDirectiveProjectPath: () => ({ projectPath: "C:/workspace/demo", source: "project" }),
        recordTaskCreationAudit: vi.fn(),
        appendTaskLog: vi.fn(),
        broadcast: vi.fn(),
        l: (ko: string[], en: string[], ja = en, zh = en) => ({ ko, en, ja, zh }),
        pickL: (pool: any) => pool.ko[0],
        notifyCeo: vi.fn(),
        isTaskWorkflowInterrupted: () => false,
        hasOpenForeignSubtasks: () => false,
        processSubtaskDelegations: vi.fn(),
        startCrossDeptCooperation: vi.fn(),
        seedApprovedPlanSubtasks,
        startPlannedApprovalMeeting,
        sendAgentMessage: vi.fn(),
        registerTaskMessengerRoute: vi.fn(),
        startTaskExecutionForAgent,
      });

      handleTaskDelegation(
        {
          id: "planning-lead",
          name: "Sage",
          name_ko: "세이지",
          role: "team_leader",
          acts_as_planning_leader: 1,
          personality: null,
          status: "idle",
          department_id: "planning",
          current_task_id: null,
          avatar_emoji: null,
          cli_provider: "codex",
          oauth_account_id: null,
          api_provider_id: null,
          api_model: null,
          cli_model: null,
          cli_reasoning_level: null,
        } as any,
        "문서 체계를 정리해 주세요",
        "msg-1",
        { projectId: "project-1", skipPlannedMeeting: true },
      );

      await vi.runAllTimersAsync();

      const createdTask = db.prepare(
        "SELECT orchestration_version, orchestration_stage, workflow_pack_key FROM tasks ORDER BY created_at DESC LIMIT 1",
      ).get() as {
        orchestration_version: number | null;
        orchestration_stage: string | null;
        workflow_pack_key: string;
      };

      expect(createdTask).toEqual({
        orchestration_version: 2,
        orchestration_stage: "owner_prep",
        workflow_pack_key: "development",
      });
      expect(startPlannedApprovalMeeting).not.toHaveBeenCalled();
      expect(seedApprovedPlanSubtasks).toHaveBeenCalledWith(
        expect.any(String),
        "planning",
        [],
        { skipPlannedMeeting: true },
      );
      expect(startTaskExecutionForAgent).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
