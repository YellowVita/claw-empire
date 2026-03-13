import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRunCompleteHandler } from "./run-complete-handler.ts";

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 15000 }).toString().trim();
}

function createRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-run-complete-child-"));
  tempDirs.push(dir);
  try {
    runGit(dir, ["init", "-b", "main"]);
  } catch {
    runGit(dir, ["init"]);
    runGit(dir, ["checkout", "-B", "main"]);
  }
  runGit(dir, ["config", "user.name", "Claw-Empire Test"]);
  runGit(dir, ["config", "user.email", "claw-empire-test@example.local"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n", "utf8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "seed"]);
  return dir;
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      task_type TEXT,
      workflow_pack_key TEXT,
      project_id TEXT,
      project_path TEXT,
      source_task_id TEXT,
      assigned_agent_id TEXT,
      department_id TEXT,
      workflow_meta_json TEXT,
      result TEXT,
      created_at INTEGER DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      target_department_id TEXT,
      delegated_task_id TEXT,
      orchestration_phase TEXT,
      cli_tool_use_id TEXT,
      created_at INTEGER DEFAULT 0,
      completed_at INTEGER,
      blocked_reason TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT,
      status TEXT,
      current_task_id TEXT,
      department_id TEXT,
      stats_tasks_done INTEGER DEFAULT 0,
      stats_xp INTEGER DEFAULT 0
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
  return db;
}

function createDeps(db: DatabaseSync) {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-run-complete-logs-"));
  tempDirs.push(logsDir);
  return {
    activeProcesses: new Map<string, unknown>(),
    stopProgressTimer: vi.fn(),
    db,
    stopRequestedTasks: new Set<string>(),
    stopRequestModeByTask: new Map<string, "pause" | "cancel">(),
    appendTaskLog: vi.fn((taskId: string, kind: string, message: string) => {
      db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)")
        .run(taskId, kind, message, 1700000000000);
    }),
    clearTaskWorkflowState: vi.fn(),
    codexThreadToSubtask: new Map<string, string>(),
    nowMs: () => 1700000000000,
    logsDir,
    broadcast: vi.fn(),
    processSubtaskDelegations: vi.fn(),
    taskWorktrees: new Map<string, { worktreePath?: string; projectPath?: string; branchName?: string }>(),
    cleanupWorktree: vi.fn(),
    findTeamLeader: vi.fn(() => null),
    getAgentDisplayName: vi.fn(() => "팀장"),
    pickL: (pool: any) => pool?.ko?.[0] ?? pool?.en?.[0] ?? "",
    l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => ({ ko, en, ja: ja ?? en, zh: zh ?? en }),
    notifyCeo: vi.fn(),
    sendAgentMessage: vi.fn(),
    resolveLang: vi.fn(() => "ko"),
    formatTaskSubtaskProgressSummary: vi.fn(() => ""),
    crossDeptNextCallbacks: new Map<string, () => void>(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map<string, () => void>(),
    finishReview: vi.fn(),
    reconcileDelegatedSubtasksAfterRun: vi.fn(),
    completeTaskWithoutReview: vi.fn(),
    isReportDesignCheckpointTask: vi.fn(() => false),
    extractReportDesignParentTaskId: vi.fn(() => null),
    resumeReportAfterDesignCheckpoint: vi.fn(),
    isPresentationReportTask: vi.fn(() => false),
    readReportFlowValue: vi.fn(() => null),
    startReportDesignCheckpoint: vi.fn(() => false),
    upsertReportFlowValue: vi.fn((desc: string | null) => desc ?? ""),
    isReportRequestTask: vi.fn(() => false),
    notifyTaskStatus: vi.fn(),
    prettyStreamJson: vi.fn((raw: string) => raw),
    getWorktreeDiffSummary: vi.fn(() => ""),
    hasVisibleDiffSummary: vi.fn(() => false),
  } as any;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("run complete handler child branch artifact capture", () => {
  it("delegated development child success stores branch artifact metadata and ready_for_parent_ingest stage", async () => {
    const repo = createRepo();
    const db = createDb();
    try {
      runGit(repo, ["checkout", "-b", "climpire/child-task"]);
      fs.writeFileSync(path.join(repo, "feature.txt"), "hello\n", "utf8");

      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, source_task_id, assigned_agent_id,
            department_id, project_id, project_path, workflow_meta_json, created_at, started_at, updated_at
          ) VALUES (?, ?, ?, 'in_progress', 'development', 'parent-1', ?, 'dev', 'project-1', ?, NULL, 1, 2, 3)
        `,
      ).run("child-task", "개발 child", "코드 작성", "dev-agent-1", repo);
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('dev-agent-1', 'Bolt', '볼트', 'working', 'child-task', 'dev', 0, 0)
        `,
      ).run();

      const deps = createDeps(db);
      deps.taskWorktrees.set("child-task", { worktreePath: repo, projectPath: repo, branchName: "climpire/child-task" });
      deps.activeProcesses.set("child-task", { pid: 77 });

      const { handleTaskRunComplete } = createRunCompleteHandler(deps);
      await handleTaskRunComplete("child-task", 0);

      const task = db.prepare("SELECT status, workflow_meta_json FROM tasks WHERE id = ?").get("child-task") as {
        status: string;
        workflow_meta_json: string | null;
      };
      const runSheet = db.prepare("SELECT stage FROM task_run_sheets WHERE task_id = ?").get("child-task") as
        | { stage: string }
        | undefined;
      const meta = JSON.parse(task.workflow_meta_json ?? "{}");

      expect(task.status).toBe("review");
      expect(runSheet?.stage).toBe("ready_for_parent_ingest");
      expect(meta.collab_branch_artifact).toEqual(
        expect.objectContaining({
          branch_name: "climpire/child-task",
          ingestion_state: "ready_for_parent_ingest",
        }),
      );
      expect(meta.collab_branch_artifact.head_sha).toBe(runGit(repo, ["rev-parse", "HEAD"]));
      expect(deps.reconcileDelegatedSubtasksAfterRun).toHaveBeenCalledWith("child-task", 0);
    } finally {
      db.close();
    }
  });

  it("integration repair failure reuses retry queue and preserves the worktree", async () => {
    const repo = createRepo();
    const db = createDb();
    try {
      runGit(repo, ["checkout", "-b", "climpire/parent-task"]);
      fs.writeFileSync(path.join(repo, "README.md"), "seed\nrepair\n", "utf8");

      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, assigned_agent_id,
            department_id, project_id, project_path, workflow_meta_json, created_at, started_at, updated_at
          ) VALUES (?, ?, ?, 'in_progress', 'development', ?, 'planning', 'project-1', ?, ?, 1, 2, 3)
        `,
      ).run(
        "parent-task",
        "부모 통합",
        "통합 복구",
        "lead-agent-1",
        repo,
        JSON.stringify({
          integration_repair_context: {
            mode: "merge_conflict_resolution",
            child_task_id: "child-task",
            child_title: "충돌 child",
            child_branch_name: "climpire/child-task",
            parent_head_sha: "parentsha111",
            child_head_sha: "childsha222",
            conflicts: ["src/app.ts"],
            updated_at: 100,
          },
        }),
      );
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('lead-agent-1', 'Sage', '세이지', 'working', 'parent-task', 'planning', 0, 0)
        `,
      ).run();

      const deps = createDeps(db);
      deps.taskWorktrees.set("parent-task", {
        worktreePath: repo,
        projectPath: repo,
        branchName: "climpire/parent-task",
      });
      deps.activeProcesses.set("parent-task", { pid: 88 });
      deps.cleanupWorktree = vi.fn();

      const { handleTaskRunComplete } = createRunCompleteHandler(deps);
      await handleTaskRunComplete("parent-task", 1);

      const task = db.prepare("SELECT status, workflow_meta_json FROM tasks WHERE id = ?").get("parent-task") as {
        status: string;
        workflow_meta_json: string | null;
      };
      const runSheet = db.prepare("SELECT stage FROM task_run_sheets WHERE task_id = ?").get("parent-task") as
        | { stage: string }
        | undefined;
      const retryRow = db.prepare("SELECT attempt_count, last_reason FROM task_retry_queue WHERE task_id = ?").get(
        "parent-task",
      ) as { attempt_count: number; last_reason: string } | undefined;
      const meta = JSON.parse(task.workflow_meta_json ?? "{}");

      expect(task.status).toBe("pending");
      expect(runSheet?.stage).toBe("integration_repair");
      expect(retryRow).toEqual({
        attempt_count: 1,
        last_reason: "integration_validation_failed",
      });
      expect(meta.integration_repair_context).toEqual(
        expect.objectContaining({
          mode: "integration_repair",
          child_task_id: "child-task",
          conflicts: ["src/app.ts"],
        }),
      );
      expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
