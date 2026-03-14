import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";
import type { ChildBranchIngestionResult } from "../core/worktree/merge.ts";

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
      workflow_meta_json TEXT,
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
        workflow_pack_key, project_path, workflow_meta_json, result, created_at, started_at, updated_at
      ) VALUES (?, ?, ?, 'review', 'planning', NULL, 'project-1', 'development', ?, NULL, ?, 1, 2, 3)
    `,
  ).run("task-1", "Ship feature", "Fix production issue", projectPath, "Result summary");
  return db;
}

function createTools(options?: {
  inspectSnapshot?: any;
  mergeResult?: {
    success: boolean;
    message: string;
    autoCommitSha?: string;
    postMergeHeadSha?: string;
    targetBranch?: "main" | "dev";
    prUrl?: string;
    strategy?: "shared_dev_pr" | "task_branch_pr";
  };
  projectPath?: string;
  mergeStrategyMode?: "shared_dev_pr" | "task_branch_pr";
  ingestChildResult?: {
    success: boolean;
    message: string;
    conflicts?: string[];
    autoCommitSha?: string;
    ingestCommitSha?: string;
  } & Pick<ChildBranchIngestionResult, "needsAiResolution" | "parentHeadSha" | "childHeadSha">;
}) {
  const projectPath = options?.projectPath ?? createTempDir("claw-pr-gate-project-");
  if (options?.mergeStrategyMode) {
    fs.writeFileSync(
      path.join(projectPath, "WORKFLOW.md"),
      `---
mergeStrategy:
  mode: ${options.mergeStrategyMode}
---
`,
      "utf8",
    );
  }
  const db = createDb(projectPath);
  const mergeToDevAndCreatePR = vi.fn(
    () =>
      options?.mergeResult ?? {
        success: true,
        message: "merged to dev",
        autoCommitSha: "auto123",
        postMergeHeadSha: "merge456",
        targetBranch: "dev",
        prUrl: "https://github.com/acme/repo/pull/12",
        strategy: "shared_dev_pr",
      },
  );
  const pushTaskBranchAndCreatePR = vi.fn(
    async () =>
      options?.mergeResult ?? {
        success: true,
        message: "task branch pr ready",
        autoCommitSha: "auto123",
        targetBranch: "dev",
        prUrl: "https://github.com/acme/repo/pull/21",
        strategy: "task_branch_pr",
      },
  );
  const ingestChildBranchIntoParent = vi.fn(
    () =>
      options?.ingestChildResult ?? {
        success: true,
        message: "child ingested",
        ingestCommitSha: "ingest123",
      },
  );
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
          worktreePath: `${projectPath}/.wt/task-1`,
          projectPath,
          branchName: "claw/task-1",
        },
      ],
    ]),
    mergeToDevAndCreatePR,
    pushTaskBranchAndCreatePR,
    mergeWorktree: vi.fn(() => ({ success: true, message: "merged" })),
    ingestChildBranchIntoParent,
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

  return {
    db,
    tools,
    mergeToDevAndCreatePR,
    pushTaskBranchAndCreatePR,
    ingestChildBranchIntoParent,
    startReviewConsensusMeeting,
    inspectTaskGithubPrFeedbackGate,
  };
}

function readReviewAudit(db: DatabaseSync, taskId: string) {
  const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get(taskId) as {
    workflow_meta_json: string | null;
  };
  const meta = JSON.parse(row.workflow_meta_json ?? "{}");
  return meta.development_review_audit ?? null;
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
      expect(readReviewAudit(db, "task-1")).toEqual(
        expect.objectContaining({
          approved_at: 10_000,
          approval_source: "review_consensus",
          auto_commit_sha: "auto123",
          post_merge_head_sha: "merge456",
          target_branch: "dev",
        }),
      );
    } finally {
      db.close();
    }
  });

  it("parent finalize는 ready child branch를 먼저 ingest하고 child를 done으로 닫는다", async () => {
    const { db, tools, mergeToDevAndCreatePR, ingestChildBranchIntoParent } = createTools();
    db.prepare(
      `
        INSERT INTO tasks (
          id, title, description, status, department_id, source_task_id, project_id,
          workflow_pack_key, project_path, workflow_meta_json, result, created_at, started_at, updated_at
        ) VALUES (?, ?, ?, 'review', 'dev', ?, 'project-1', 'development', ?, ?, ?, 4, 5, 6)
      `,
    ).run(
      "child-1",
      "Child deliverable",
      "Implements code",
      "task-1",
      "/tmp/project",
      JSON.stringify({
        collab_branch_artifact: {
          branch_name: "climpire/child-1",
          head_sha: "childsha123",
          auto_commit_sha: "childauto123",
          ingestion_state: "ready_for_parent_ingest",
          updated_at: 9_000,
          ingested_by_task_id: null,
          ingested_commit_sha: null,
          ingested_at: null,
          orphaned_reason: null,
        },
      }),
      "child result",
    );

    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });
      await vi.waitFor(() => {
        const parent = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1") as { status: string };
        const child = db.prepare("SELECT status FROM tasks WHERE id = ?").get("child-1") as { status: string };
        expect(parent.status).toBe("done");
        expect(child.status).toBe("done");
      });

      expect(ingestChildBranchIntoParent).toHaveBeenCalledWith("task-1", "child-1");
      expect(mergeToDevAndCreatePR).toHaveBeenCalledTimes(1);
      const childMeta = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get("child-1") as {
        workflow_meta_json: string | null;
      };
      const parsed = JSON.parse(childMeta.workflow_meta_json ?? "{}");
      expect(parsed.collab_branch_artifact).toEqual(
        expect.objectContaining({
          ingestion_state: "ingested",
          ingested_by_task_id: "task-1",
          ingested_commit_sha: "ingest123",
        }),
      );
    } finally {
      db.close();
    }
  });

  it("child ingestion conflict가 나면 parent는 pending repair로 전환되고 main/dev merge를 시작하지 않는다", async () => {
    const { db, tools, mergeToDevAndCreatePR } = createTools({
      ingestChildResult: {
        success: false,
        message: "Child branch ingestion conflict: 1 file(s) require manual resolution.",
        conflicts: ["src/app.ts"],
        needsAiResolution: true,
        parentHeadSha: "parentsha111",
        childHeadSha: "childsha999",
      },
    });
    db.prepare(
      `
        INSERT INTO tasks (
          id, title, description, status, department_id, source_task_id, project_id,
          workflow_pack_key, project_path, workflow_meta_json, result, created_at, started_at, updated_at
        ) VALUES (?, ?, ?, 'review', 'dev', ?, 'project-1', 'development', ?, ?, ?, 4, 5, 6)
      `,
    ).run(
      "child-conflict",
      "Child conflict",
      "Conflicting code",
      "task-1",
      "/tmp/project",
      JSON.stringify({
        collab_branch_artifact: {
          branch_name: "climpire/child-conflict",
          head_sha: "childsha999",
          auto_commit_sha: "childauto999",
          ingestion_state: "ready_for_parent_ingest",
          updated_at: 9_000,
          ingested_by_task_id: null,
          ingested_commit_sha: null,
          ingested_at: null,
          orphaned_reason: null,
        },
      }),
      "child result",
    );

    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });
      await vi.waitFor(() => {
        const parent = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1") as { status: string };
        expect(parent.status).toBe("pending");
      });

      expect(mergeToDevAndCreatePR).not.toHaveBeenCalled();
      const runSheet = db.prepare("SELECT stage FROM task_run_sheets WHERE task_id = ?").get("task-1") as
        | { stage: string }
        | undefined;
      expect(runSheet?.stage).toBe("merge_conflict_resolution");
      const retryRow = db.prepare("SELECT attempt_count, last_reason FROM task_retry_queue WHERE task_id = ?").get(
        "task-1",
      ) as { attempt_count: number; last_reason: string } | undefined;
      expect(retryRow).toEqual({
        attempt_count: 1,
        last_reason: "integration_validation_failed",
      });
      const childMeta = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get("child-conflict") as {
        workflow_meta_json: string | null;
      };
      expect(JSON.parse(childMeta.workflow_meta_json ?? "{}").collab_branch_artifact).toEqual(
        expect.objectContaining({
          ingestion_state: "conflict_pending_resolution",
        }),
      );
      const parentMeta = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get("task-1") as {
        workflow_meta_json: string | null;
      };
      expect(JSON.parse(parentMeta.workflow_meta_json ?? "{}").integration_repair_context).toEqual(
        expect.objectContaining({
          mode: "merge_conflict_resolution",
          child_task_id: "child-conflict",
          conflicts: ["src/app.ts"],
        }),
      );
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
        autoCommitSha: "auto-conflict-1",
      })),
      mergeWorktree: vi.fn(() => ({ success: true, message: "merged" })),
      ingestChildBranchIntoParent: vi.fn(() => ({ success: true, message: "child ingested", ingestCommitSha: "ingest123" })),
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
      expect(readReviewAudit(db, "task-1")).toEqual(
        expect.objectContaining({
          approved_at: 10_000,
          approval_source: "review_consensus",
          auto_commit_sha: "auto-conflict-1",
          post_merge_head_sha: null,
          target_branch: null,
        }),
      );
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
        autoCommitSha: "auto-first",
      })
      .mockReturnValueOnce({
        success: true,
        message: "merged to dev",
        autoCommitSha: "auto-second",
        postMergeHeadSha: "merge-second",
        targetBranch: "dev",
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
      ingestChildBranchIntoParent: vi.fn(() => ({ success: true, message: "child ingested", ingestCommitSha: "ingest123" })),
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
      expect(readReviewAudit(db, "task-1")).toEqual(
        expect.objectContaining({
          approved_at: 10_000,
          approval_source: "review_consensus",
          auto_commit_sha: "auto-second",
          post_merge_head_sha: "merge-second",
          target_branch: "dev",
        }),
      );
    } finally {
      db.close();
    }
  });

  it("delegated child finalize는 parent ingestion 전에는 ready_for_parent_ingest에 머문다", async () => {
    const db = createDb();
    db.prepare("UPDATE tasks SET source_task_id = ? WHERE id = ?").run("parent-1", "task-1");
    db.prepare("UPDATE tasks SET workflow_meta_json = ? WHERE id = ?").run(
      JSON.stringify({
        collab_branch_artifact: {
          branch_name: "climpire/task-1",
          head_sha: "abc123",
          auto_commit_sha: "auto123",
          ingestion_state: "ready_for_parent_ingest",
          updated_at: 9_000,
          ingested_by_task_id: null,
          ingested_commit_sha: null,
          ingested_at: null,
          orphaned_reason: null,
        },
      }),
      "task-1",
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
      taskWorktrees: new Map(),
      mergeToDevAndCreatePR: vi.fn(),
      mergeWorktree: vi.fn(),
      ingestChildBranchIntoParent: vi.fn(() => ({ success: true, message: "child ingested", ingestCommitSha: "ingest123" })),
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
      startReviewConsensusMeeting: vi.fn(),
      processSubtaskDelegations: vi.fn(),
      inspectTaskGithubPrFeedbackGate: vi.fn(),
    } as any);

    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });

      await vi.waitFor(() => {
        const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1") as { status: string };
        const runSheet = db.prepare("SELECT stage FROM task_run_sheets WHERE task_id = ?").get("task-1") as
          | { stage: string }
          | undefined;
        expect(task.status).toBe("review");
        expect(runSheet?.stage).toBe("ready_for_parent_ingest");
      });

      expect(readReviewAudit(db, "task-1")).toEqual(
        expect.objectContaining({
          approved_at: 10_000,
          approval_source: "delegated_review_finalize",
        }),
      );
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
          headBranch: "dev",
          baseBranch: "main",
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

  it("task_branch_pr 전략은 gate가 blocked여도 task PR 생성 후 done으로 끝난다", async () => {
    const { db, tools, mergeToDevAndCreatePR, pushTaskBranchAndCreatePR, inspectTaskGithubPrFeedbackGate } = createTools({
      mergeStrategyMode: "task_branch_pr",
      inspectSnapshot: {
        applicable: true,
        status: "blocked",
        pr_url: "https://github.com/acme/repo/pull/21",
        pr_number: 21,
        review_decision: "CHANGES_REQUESTED",
        unresolved_thread_count: 1,
        change_requests_count: 1,
        failing_check_count: 0,
        pending_check_count: 1,
        ignored_check_count: 0,
        ignored_check_names: [],
        blocking_reasons: ["Unresolved review threads: 1", "Pending checks: 1"],
        checked_at: 10_000,
      },
      mergeResult: {
        success: true,
        message: "task branch pr ready",
        autoCommitSha: "auto-task-1",
        targetBranch: "dev",
        prUrl: "https://github.com/acme/repo/pull/21",
        strategy: "task_branch_pr",
      },
    });

    try {
      tools.finishReview("task-1", "Ship feature", { bypassProjectDecisionGate: true, trigger: "test" });
      await vi.waitFor(() => {
        const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1") as { status: string };
        expect(task.status).toBe("done");
      });

      expect(mergeToDevAndCreatePR).not.toHaveBeenCalled();
      expect(pushTaskBranchAndCreatePR).toHaveBeenCalledTimes(1);
      expect(inspectTaskGithubPrFeedbackGate).toHaveBeenCalledTimes(1);
      expect(inspectTaskGithubPrFeedbackGate).toHaveBeenCalledWith(
        expect.objectContaining({
          headBranch: "claw/task-1",
          baseBranch: "dev",
        }),
      );
      expect(readReviewAudit(db, "task-1")).toEqual(
        expect.objectContaining({
          auto_commit_sha: "auto-task-1",
          post_merge_head_sha: null,
          target_branch: "dev",
          merge_strategy: "task_branch_pr",
          pr_url: "https://github.com/acme/repo/pull/21",
        }),
      );
    } finally {
      db.close();
    }
  });
});
