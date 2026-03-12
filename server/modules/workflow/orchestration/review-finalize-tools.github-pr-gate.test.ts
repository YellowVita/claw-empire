import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createDb(projectPath = "/tmp/project"): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      department_id TEXT,
      source_task_id TEXT,
      project_id TEXT,
      workflow_pack_key TEXT,
      project_path TEXT,
      result TEXT,
      created_at INTEGER DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      github_repo TEXT
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      delegated_task_id TEXT,
      blocked_reason TEXT,
      completed_at INTEGER
    );
    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_type TEXT NOT NULL
    );
    CREATE TABLE task_quality_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      details TEXT,
      required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      evidence_markdown TEXT,
      source TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE task_quality_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      quality_item_id TEXT,
      run_type TEXT NOT NULL,
      name TEXT NOT NULL,
      command TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      summary TEXT,
      output_excerpt TEXT,
      metadata_json TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      quality_item_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT,
      mime TEXT,
      size_bytes INTEGER,
      source TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_execution_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      attempt_count INTEGER,
      hook_source TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_retry_queue (
      task_id TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE task_run_sheets (
      task_id TEXT PRIMARY KEY,
      workflow_pack_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_markdown TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO projects (id, github_repo) VALUES (?, ?)").run("project-1", "acme/repo");
  db.prepare(
    `
      INSERT INTO tasks (
        id, title, description, status, department_id, source_task_id, project_id,
        workflow_pack_key, project_path, result, created_at, started_at, updated_at
      ) VALUES (?, ?, ?, 'review', 'planning', NULL, 'project-1', 'development', ?, ?, 1, 2, 3)
    `,
  ).run("task-1", "Ship feature", "Fix production issue", projectPath, "Result summary");
  return db;
}

function createTools(options?: {
  inspectSnapshot?: any;
  mergeResult?: { success: boolean; message: string };
  projectPath?: string;
}) {
  const db = createDb(options?.projectPath);
  const mergeToDevAndCreatePR = vi.fn(() => options?.mergeResult ?? { success: true, message: "merged to dev" });
  const startReviewConsensusMeeting = vi.fn((_taskId, _taskTitle, _departmentId, onApproved) => {
    onApproved();
  });
  const inspectTaskGithubPrFeedbackGate = vi.fn(async () =>
    options?.inspectSnapshot ?? {
      applicable: true,
      status: "passed",
      pr_url: "https://github.com/acme/repo/pull/12",
      pr_number: 12,
      review_decision: "APPROVED",
      unresolved_thread_count: 0,
      change_requests_count: 0,
      failing_check_count: 0,
      pending_check_count: 0,
      ignored_check_count: 0,
      ignored_check_names: [],
      blocking_reasons: [],
      checked_at: 10_000,
    },
  );

  const tools = createReviewFinalizeTools({
    db,
    nowMs: () => 10_000,
    logsDir: null,
    broadcast: vi.fn(),
    appendTaskLog: vi.fn(),
    getPreferredLanguage: () => "en",
    pickL: (pool: any, lang: string) => (pool?.[lang]?.[0] ?? pool?.en?.[0] ?? ""),
    l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
    resolveLang: () => "en",
    getProjectReviewGateSnapshot: () => ({ activeReview: 1, activeTotal: 1, ready: true }),
    projectReviewGateNotifiedAt: new Map<string, number>(),
    notifyCeo: vi.fn(),
    taskWorktrees: new Map([
      [
        "task-1",
        {
          worktreePath: "/tmp/project/.wt/task-1",
          projectPath: "/tmp/project",
          branchName: "claw/task-1",
        },
      ],
    ]),
    mergeToDevAndCreatePR,
    mergeWorktree: vi.fn(() => ({ success: true, message: "merged" })),
    cleanupWorktree: vi.fn(),
    findTeamLeader: vi.fn(() => null),
    getAgentDisplayName: vi.fn(() => "Team Lead"),
    setTaskCreationAuditCompletion: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    notifyTaskStatus: vi.fn(),
    refreshCliUsageData: vi.fn(async () => ({})),
    shouldDeferTaskReportUntilPlanningArchive: vi.fn(() => false),
    emitTaskReportEvent: vi.fn(),
    formatTaskSubtaskProgressSummary: vi.fn(() => ""),
    reviewRoundState: new Map<string, number>(),
    reviewInFlight: new Set<string>(),
    archivePlanningConsolidatedReport: vi.fn(async () => undefined),
    crossDeptNextCallbacks: new Map<string, () => void>(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map<string, () => void>(),
    startReviewConsensusMeeting,
    processSubtaskDelegations: vi.fn(),
    inspectTaskGithubPrFeedbackGate,
  } as any);

  return { db, tools, mergeToDevAndCreatePR, startReviewConsensusMeeting, inspectTaskGithubPrFeedbackGate };
}

describe("review finalize GitHub PR gate", () => {
  it("blocked snapshot이면 merge를 중단하고 quality run을 기록한다", async () => {
    const { db, tools, mergeToDevAndCreatePR } = createTools({
      inspectSnapshot: {
        applicable: true,
        status: "blocked",
        pr_url: "https://github.com/acme/repo/pull/12",
        pr_number: 12,
        review_decision: "CHANGES_REQUESTED",
        unresolved_thread_count: 2,
        change_requests_count: 1,
        failing_check_count: 1,
        pending_check_count: 0,
        blocking_reasons: ["Unresolved review threads: 2", "Failing checks: 1"],
        checked_at: 10_000,
      },
    });
    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });
      await vi.waitFor(() => {
        const run = db
          .prepare("SELECT name, status FROM task_quality_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
          .get("task-1") as { name: string; status: string } | undefined;
        expect(run).toEqual({
          name: "github_pr_feedback_gate",
          status: "failed",
        });
      });

      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1") as { status: string };
      const runSheet = db.prepare("SELECT stage FROM task_run_sheets WHERE task_id = ?").get("task-1") as
        | { stage: string }
        | undefined;

      expect(task.status).toBe("review");
      expect(runSheet?.stage).toBe("human_review");
      expect(mergeToDevAndCreatePR).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("passed snapshot이면 기존 merge/create PR 흐름을 유지한다", async () => {
    const { db, tools, mergeToDevAndCreatePR } = createTools();
    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });
      await vi.waitFor(() => {
        const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1") as { status: string };
        expect(task.status).toBe("done");
      });

      const run = db
        .prepare("SELECT name, status FROM task_quality_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
        .get("task-1") as { name: string; status: string } | undefined;
      const runSheet = db.prepare("SELECT stage FROM task_run_sheets WHERE task_id = ?").get("task-1") as
        | { stage: string }
        | undefined;

      expect(run).toEqual({
        name: "github_pr_feedback_gate",
        status: "passed",
      });
      expect(runSheet?.stage).toBe("done");
      expect(mergeToDevAndCreatePR).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("merge failure면 task를 review에 유지하고 done 전이를 중단한다", async () => {
    const db = createDb();
    const appendTaskLog = vi.fn((taskId: string, kind: string, message: string) => {
      db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)")
        .run(taskId, kind, message, 10_000);
    });
    const cleanupWorktree = vi.fn();
    const endTaskExecutionSession = vi.fn();
    const notifyTaskStatus = vi.fn();
    const emitTaskReportEvent = vi.fn();
    const archivePlanningConsolidatedReport = vi.fn(async () => undefined);
    const reviewRoundState = new Map<string, number>([["task-1", 2]]);
    const reviewInFlight = new Set<string>(["task-1"]);

    const tools = createReviewFinalizeTools({
      db,
      nowMs: () => 10_000,
      logsDir: null,
      broadcast: vi.fn(),
      appendTaskLog,
      getPreferredLanguage: () => "en",
      pickL: (pool: any, lang: string) => (pool?.[lang]?.[0] ?? pool?.en?.[0] ?? ""),
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      resolveLang: () => "en",
      getProjectReviewGateSnapshot: () => ({ activeReview: 1, activeTotal: 1, ready: true }),
      projectReviewGateNotifiedAt: new Map<string, number>(),
      notifyCeo: vi.fn(),
      taskWorktrees: new Map([
        [
          "task-1",
          {
            worktreePath: "/tmp/project/.wt/task-1",
            projectPath: "/tmp/project",
            branchName: "claw/task-1",
          },
        ],
      ]),
      mergeToDevAndCreatePR: vi.fn(() => ({
        success: false,
        message: "Merge conflict: 1 file(s) have conflicts and need manual resolution.",
        conflicts: ["src/app.ts"],
      })),
      mergeWorktree: vi.fn(() => ({ success: true, message: "merged" })),
      cleanupWorktree,
      findTeamLeader: vi.fn(() => null),
      getAgentDisplayName: vi.fn(() => "Team Lead"),
      setTaskCreationAuditCompletion: vi.fn(),
      endTaskExecutionSession,
      notifyTaskStatus,
      refreshCliUsageData: vi.fn(async () => ({})),
      shouldDeferTaskReportUntilPlanningArchive: vi.fn(() => false),
      emitTaskReportEvent,
      formatTaskSubtaskProgressSummary: vi.fn(() => ""),
      reviewRoundState,
      reviewInFlight,
      archivePlanningConsolidatedReport,
      crossDeptNextCallbacks: new Map<string, () => void>(),
      recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
      subtaskDelegationCallbacks: new Map<string, () => void>(),
      startReviewConsensusMeeting: vi.fn((_taskId, _taskTitle, _departmentId, onApproved) => {
        onApproved();
      }),
      processSubtaskDelegations: vi.fn(),
      inspectTaskGithubPrFeedbackGate: vi.fn(async () => ({
        applicable: true,
        status: "passed",
        pr_url: "https://github.com/acme/repo/pull/12",
        pr_number: 12,
        review_decision: "APPROVED",
        unresolved_thread_count: 0,
        change_requests_count: 0,
        failing_check_count: 0,
        pending_check_count: 0,
        ignored_check_count: 0,
        ignored_check_names: [],
        blocking_reasons: [],
        checked_at: 10_000,
      })),
    } as any);

    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });

      await vi.waitFor(() => {
        const runSheet = db.prepare("SELECT stage, snapshot_json FROM task_run_sheets WHERE task_id = ?").get("task-1") as
          | { stage: string; snapshot_json: string }
          | undefined;
        const snapshot = JSON.parse(runSheet?.snapshot_json ?? "{}");
        expect(runSheet?.stage).toBe("human_review");
        expect(snapshot.review_checklist?.merge_status).toBe("failed");
      });

      const task = db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get("task-1") as {
        status: string;
        completed_at: number | null;
      };

      expect(task.status).toBe("review");
      expect(task.completed_at).toBeNull();
      expect(cleanupWorktree).not.toHaveBeenCalled();
      expect(endTaskExecutionSession).not.toHaveBeenCalled();
      expect(notifyTaskStatus).not.toHaveBeenCalled();
      expect(archivePlanningConsolidatedReport).not.toHaveBeenCalled();
      expect(emitTaskReportEvent).toHaveBeenCalledWith("task-1");
      expect(reviewInFlight.has("task-1")).toBe(false);
      expect(reviewRoundState.has("task-1")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("merge failure 후 같은 finalize 경로를 재시도하면 성공 시 done으로 끝난다", async () => {
    const db = createDb();
    const appendTaskLog = vi.fn((taskId: string, kind: string, message: string) => {
      db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)")
        .run(taskId, kind, message, 10_000);
    });
    const mergeToDevAndCreatePR = vi
      .fn()
      .mockReturnValueOnce({
        success: false,
        message: "Merge conflict: 1 file(s) have conflicts and need manual resolution.",
        conflicts: ["src/app.ts"],
      })
      .mockReturnValueOnce({
        success: true,
        message: "merged to dev",
      });
    const reviewRoundState = new Map<string, number>([["task-1", 2]]);
    const reviewInFlight = new Set<string>(["task-1"]);

    const tools = createReviewFinalizeTools({
      db,
      nowMs: () => 10_000,
      logsDir: null,
      broadcast: vi.fn(),
      appendTaskLog,
      getPreferredLanguage: () => "en",
      pickL: (pool: any, lang: string) => (pool?.[lang]?.[0] ?? pool?.en?.[0] ?? ""),
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      resolveLang: () => "en",
      getProjectReviewGateSnapshot: () => ({ activeReview: 1, activeTotal: 1, ready: true }),
      projectReviewGateNotifiedAt: new Map<string, number>(),
      notifyCeo: vi.fn(),
      taskWorktrees: new Map([
        [
          "task-1",
          {
            worktreePath: "/tmp/project/.wt/task-1",
            projectPath: "/tmp/project",
            branchName: "claw/task-1",
          },
        ],
      ]),
      mergeToDevAndCreatePR,
      mergeWorktree: vi.fn(() => ({ success: true, message: "merged" })),
      cleanupWorktree: vi.fn(),
      findTeamLeader: vi.fn(() => null),
      getAgentDisplayName: vi.fn(() => "Team Lead"),
      setTaskCreationAuditCompletion: vi.fn(),
      endTaskExecutionSession: vi.fn(),
      notifyTaskStatus: vi.fn(),
      refreshCliUsageData: vi.fn(async () => ({})),
      shouldDeferTaskReportUntilPlanningArchive: vi.fn(() => false),
      emitTaskReportEvent: vi.fn(),
      formatTaskSubtaskProgressSummary: vi.fn(() => ""),
      reviewRoundState,
      reviewInFlight,
      archivePlanningConsolidatedReport: vi.fn(async () => undefined),
      crossDeptNextCallbacks: new Map<string, () => void>(),
      recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
      subtaskDelegationCallbacks: new Map<string, () => void>(),
      startReviewConsensusMeeting: vi.fn((_taskId, _taskTitle, _departmentId, onApproved) => {
        onApproved();
      }),
      processSubtaskDelegations: vi.fn(),
      inspectTaskGithubPrFeedbackGate: vi.fn(async () => ({
        applicable: true,
        status: "passed",
        pr_url: "https://github.com/acme/repo/pull/12",
        pr_number: 12,
        review_decision: "APPROVED",
        unresolved_thread_count: 0,
        change_requests_count: 0,
        failing_check_count: 0,
        pending_check_count: 0,
        ignored_check_count: 0,
        ignored_check_names: [],
        blocking_reasons: [],
        checked_at: 10_000,
      })),
    } as any);

    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });
      await vi.waitFor(() => {
        const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1") as { status: string };
        expect(task.status).toBe("review");
      });

      reviewInFlight.add("task-1");
      reviewRoundState.set("task-1", 3);
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "retry" });

      await vi.waitFor(() => {
        const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1") as { status: string };
        expect(task.status).toBe("done");
      });

      expect(mergeToDevAndCreatePR).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it("review finalize는 project workflow policy를 읽어 gate helper에 전달한다", async () => {
    const projectDir = createTempDir("claw-pr-gate-policy-");
    fs.writeFileSync(
      path.join(projectDir, "WORKFLOW.md"),
      `---
developmentPrFeedbackGate:
  ignoredCheckNames:
    - preview / deploy
  ignoredCheckPrefixes:
    - optional /
---
`,
      "utf8",
    );

    const { db, tools, inspectTaskGithubPrFeedbackGate } = createTools({ projectPath: projectDir });
    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });
      await vi.waitFor(() => {
        expect(inspectTaskGithubPrFeedbackGate).toHaveBeenCalledTimes(1);
      });
      expect(inspectTaskGithubPrFeedbackGate).toHaveBeenCalledWith(
        expect.objectContaining({
          githubRepo: "acme/repo",
          policy: {
            ignoredCheckNames: ["preview / deploy"],
            ignoredCheckPrefixes: ["optional /"],
          },
        }),
      );
    } finally {
      db.close();
    }
  });
});
