import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      department_id TEXT,
      source_task_id TEXT,
      project_id TEXT,
      workflow_pack_key TEXT,
      project_path TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
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
  `);
  return db;
}

describe("review finalize video gate", () => {
  it("project path가 없으면 video_preprod 승인/머지를 보류한다", () => {
    const db = createDb();
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-review-no-project-path-"));
    try {
      const taskId = "task-video-no-project-path";
      db.prepare(
        `
          INSERT INTO tasks (id, title, status, department_id, source_task_id, project_id, workflow_pack_key, project_path, created_at, updated_at)
          VALUES (?, ?, 'review', 'planning', NULL, 'project-1', 'video_preprod', NULL, 1, 1)
        `,
      ).run(taskId, "Video intro");

      const appendTaskLog = vi.fn();
      const notifyCeo = vi.fn();
      const startReviewConsensusMeeting = vi.fn();
      const mergeWorktree = vi.fn(() => ({ success: true, message: "merged" }));

      const tools = createReviewFinalizeTools({
        db,
        nowMs: () => 1700000000000,
        logsDir,
        broadcast: vi.fn(),
        appendTaskLog,
        getPreferredLanguage: () => "ko",
        pickL: (pool: any) => (Array.isArray(pool?.ko) ? pool.ko[0] : ""),
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        resolveLang: () => "ko",
        getProjectReviewGateSnapshot: () => ({ activeReview: 1, activeTotal: 1, ready: true }),
        projectReviewGateNotifiedAt: new Map<string, number>(),
        notifyCeo,
        taskWorktrees: new Map<string, { worktreePath: string; projectPath: string; branchName: string }>(),
        mergeToDevAndCreatePR: vi.fn(() => ({ success: true, message: "pr created" })),
        mergeWorktree,
        cleanupWorktree: vi.fn(),
        findTeamLeader: vi.fn(() => null),
        getAgentDisplayName: vi.fn(() => "팀장"),
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
      } as any);

      tools.finishReview(taskId, "Video intro", {
        bypassProjectDecisionGate: true,
        trigger: "test",
      });

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(startReviewConsensusMeeting).not.toHaveBeenCalled();
      expect(mergeWorktree).not.toHaveBeenCalled();
      expect(appendTaskLog).toHaveBeenCalledWith(
        taskId,
        "system",
        expect.stringContaining("missing project path"),
      );
      expect(notifyCeo).toHaveBeenCalled();
    } finally {
      try {
        fs.rmSync(logsDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      db.close();
    }
  });

  it("video_preprod task는 final.mp4 확인 전 승인/머지를 진행하지 않는다", () => {
    const db = createDb();
    try {
      const taskId = "task-video-1";
      db.prepare(
        `
          INSERT INTO tasks (id, title, status, department_id, source_task_id, project_id, workflow_pack_key, project_path, created_at, updated_at)
          VALUES (?, ?, 'review', 'planning', NULL, 'project-1', 'video_preprod', ?, 1, 1)
        `,
      ).run(taskId, "Video intro", "/tmp/non-existing-video-root");

      const appendTaskLog = vi.fn();
      const notifyCeo = vi.fn();
      const startReviewConsensusMeeting = vi.fn();
      const mergeWorktree = vi.fn(() => ({ success: true, message: "merged" }));

      const tools = createReviewFinalizeTools({
        db,
        nowMs: () => 1700000000000,
        broadcast: vi.fn(),
        appendTaskLog,
        getPreferredLanguage: () => "ko",
        pickL: (pool: any) => (Array.isArray(pool?.ko) ? pool.ko[0] : ""),
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        resolveLang: () => "ko",
        getProjectReviewGateSnapshot: () => ({ activeReview: 1, activeTotal: 1, ready: true }),
        projectReviewGateNotifiedAt: new Map<string, number>(),
        notifyCeo,
        taskWorktrees: new Map<string, { worktreePath: string; projectPath: string; branchName: string }>(),
        mergeToDevAndCreatePR: vi.fn(() => ({ success: true, message: "pr created" })),
        mergeWorktree,
        cleanupWorktree: vi.fn(),
        findTeamLeader: vi.fn(() => null),
        getAgentDisplayName: vi.fn(() => "팀장"),
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
      } as any);

      tools.finishReview(taskId, "Video intro", {
        bypassProjectDecisionGate: true,
        trigger: "test",
      });

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(startReviewConsensusMeeting).not.toHaveBeenCalled();
      expect(mergeWorktree).not.toHaveBeenCalled();
      expect(appendTaskLog).toHaveBeenCalledWith(
        taskId,
        "system",
        expect.stringContaining("Review hold: video artifact gate blocked approval"),
      );
      expect(notifyCeo).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("video artifact가 있어도 Remotion 증빙이 없으면 승인/머지를 차단한다", () => {
    const db = createDb();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-review-gate-"));
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-review-logs-"));
    try {
      const taskId = "task-video-remotion-missing";
      const outputDir = path.join(projectRoot, "video_output");
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, "final.mp4"), "dummy-video", "utf8");

      db.prepare(
        `
          INSERT INTO tasks (id, title, status, department_id, source_task_id, project_id, workflow_pack_key, project_path, created_at, updated_at)
          VALUES (?, ?, 'review', 'planning', NULL, 'project-1', 'video_preprod', ?, 1, 1)
        `,
      ).run(taskId, "Video intro", projectRoot);

      const appendTaskLog = vi.fn();
      const notifyCeo = vi.fn();
      const startReviewConsensusMeeting = vi.fn();
      const mergeWorktree = vi.fn(() => ({ success: true, message: "merged" }));

      const tools = createReviewFinalizeTools({
        db,
        nowMs: () => 1700000000000,
        logsDir,
        broadcast: vi.fn(),
        appendTaskLog,
        getPreferredLanguage: () => "ko",
        pickL: (pool: any) => (Array.isArray(pool?.ko) ? pool.ko[0] : ""),
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        resolveLang: () => "ko",
        getProjectReviewGateSnapshot: () => ({ activeReview: 1, activeTotal: 1, ready: true }),
        projectReviewGateNotifiedAt: new Map<string, number>(),
        notifyCeo,
        taskWorktrees: new Map<string, { worktreePath: string; projectPath: string; branchName: string }>(),
        mergeToDevAndCreatePR: vi.fn(() => ({ success: true, message: "pr created" })),
        mergeWorktree,
        cleanupWorktree: vi.fn(),
        findTeamLeader: vi.fn(() => null),
        getAgentDisplayName: vi.fn(() => "팀장"),
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
      } as any);

      tools.finishReview(taskId, "Video intro", {
        bypassProjectDecisionGate: true,
        trigger: "test",
      });

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(startReviewConsensusMeeting).not.toHaveBeenCalled();
      expect(mergeWorktree).not.toHaveBeenCalled();
      expect(appendTaskLog).toHaveBeenCalledWith(
        taskId,
        "system",
        expect.stringContaining("remotion evidence missing/invalid"),
      );
      expect(notifyCeo).toHaveBeenCalled();
    } finally {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      try {
        fs.rmSync(logsDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      db.close();
    }
  });

  it("video artifact와 Remotion 증빙이 있으면 quality evidence를 기록하고 review 합의 단계로 진행한다", () => {
    const db = createDb();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-review-gate-ok-"));
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-review-logs-ok-"));
    try {
      const taskId = "task-video-remotion-ok";
      const outputDir = path.join(projectRoot, "video_output");
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, "final.mp4"), "dummy-video", "utf8");
      fs.writeFileSync(
        path.join(logsDir, `${taskId}.log`),
        "pnpm exec remotion render src/index.ts Intro video_output/final.mp4 --log=verbose",
        "utf8",
      );

      db.prepare(
        `
          INSERT INTO tasks (id, title, status, department_id, source_task_id, project_id, workflow_pack_key, project_path, created_at, updated_at)
          VALUES (?, ?, 'review', 'planning', NULL, 'project-1', 'video_preprod', ?, 1, 1)
        `,
      ).run(taskId, "Video intro", projectRoot);

      const startReviewConsensusMeeting = vi.fn();
      const tools = createReviewFinalizeTools({
        db,
        nowMs: () => 1700000000000,
        logsDir,
        broadcast: vi.fn(),
        appendTaskLog: vi.fn(),
        getPreferredLanguage: () => "ko",
        pickL: (pool: any) => (Array.isArray(pool?.ko) ? pool.ko[0] : ""),
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        resolveLang: () => "ko",
        getProjectReviewGateSnapshot: () => ({ activeReview: 1, activeTotal: 1, ready: true }),
        projectReviewGateNotifiedAt: new Map<string, number>(),
        notifyCeo: vi.fn(),
        taskWorktrees: new Map<string, { worktreePath: string; projectPath: string; branchName: string }>(),
        mergeToDevAndCreatePR: vi.fn(() => ({ success: true, message: "pr created" })),
        mergeWorktree: vi.fn(() => ({ success: true, message: "merged" })),
        cleanupWorktree: vi.fn(),
        findTeamLeader: vi.fn(() => null),
        getAgentDisplayName: vi.fn(() => "팀장"),
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
      } as any);

      tools.finishReview(taskId, "Video intro", {
        bypassProjectDecisionGate: true,
        trigger: "test",
      });

      const runRow = db
        .prepare("SELECT run_type, status, name FROM task_quality_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(taskId) as { run_type: string; status: string; name: string } | undefined;
      const artifactRow = db
        .prepare("SELECT kind, title, source FROM task_artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(taskId) as { kind: string; title: string; source: string } | undefined;

      expect(runRow).toEqual({
        run_type: "artifact_check",
        status: "passed",
        name: "video_review_gate_verification",
      });
      expect(artifactRow).toEqual({
        kind: "video",
        title: "final.mp4",
        source: "video_gate",
      });
      expect(startReviewConsensusMeeting).toHaveBeenCalledWith(taskId, "Video intro", "planning", expect.any(Function));
    } finally {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      try {
        fs.rmSync(logsDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      db.close();
    }
  });
});
