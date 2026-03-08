import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createWorktreeLifecycleTools } from "../../workflow/core/worktree/lifecycle.ts";
import { registerWorktreeAndUsageRoutes } from "./worktrees-and-usage.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 15000 }).toString().trim();
}

function initRepo(basePrefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), basePrefix));
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

function createHarness(taskWorktrees: Map<string, { worktreePath: string; branchName: string; projectPath: string }>) {
  const appendLogCalls: Array<{ taskId: string | null; kind: string; message: string }> = [];
  const rollbackCalls: Array<{ taskId: string; reason: string }> = [];
  const endSessionCalls: Array<{ taskId: string; reason: string }> = [];
  const clearWorkflowCalls: string[] = [];
  const broadcastCalls: Array<{ event: string; payload: unknown }> = [];
  const killPidCalls: number[] = [];
  const stopProgressCalls: string[] = [];
  const getRoutes = new Map<string, RouteHandler>();
  const postRoutes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      getRoutes.set(path, handler);
      return this;
    },
    post(path: string, handler: RouteHandler) {
      postRoutes.set(path, handler);
      return this;
    },
  };

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      current_task_id TEXT
    );
    CREATE TABLE task_retry_queue (
      task_id TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE cli_usage_cache (
      provider TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const activeProcesses = new Map<string, { pid: number; kill?: () => void }>();
  const stopRequestedTasks = new Set<string>();
  const stopRequestModeByTask = new Map<string, "pause" | "cancel">();
  registerWorktreeAndUsageRoutes({
    app: app as any,
    taskWorktrees,
    mergeWorktree: () => ({ success: true, message: "merged", conflicts: [] }),
    cleanupWorktree: () => {},
    rollbackTaskWorktree: (taskId: string, reason: string) => {
      rollbackCalls.push({ taskId, reason });
      taskWorktrees.delete(taskId);
      return true;
    },
    appendTaskLog: (taskId: string | null, kind: string, message: string) => {
      appendLogCalls.push({ taskId, kind, message });
    },
    resolveLang: () => "en",
    pickL: (value: string) => value,
    l: (_ko: string[], en: string[]) => en.join(""),
    notifyCeo: () => {},
    db: db as any,
    nowMs: () => Date.now(),
    activeProcesses,
    stopRequestedTasks,
    stopRequestModeByTask,
    stopProgressTimer: (taskId: string) => {
      stopProgressCalls.push(taskId);
    },
    killPidTree: (pid: number) => {
      killPidCalls.push(pid);
    },
    clearTaskWorkflowState: (taskId: string) => {
      clearWorkflowCalls.push(taskId);
    },
    endTaskExecutionSession: (taskId: string, reason: string) => {
      endSessionCalls.push({ taskId, reason });
    },
    CLI_TOOLS: [],
    fetchClaudeUsage: async () => ({ windows: [], error: "not_implemented" }),
    fetchCodexUsage: async () => ({ windows: [], error: "not_implemented" }),
    fetchGeminiUsage: async () => ({ windows: [], error: "not_implemented" }),
    broadcast: (event: string, payload: unknown) => {
      broadcastCalls.push({ event, payload });
    },
  } as any);

  return {
    db,
    getRoutes,
    postRoutes,
    appendLogCalls,
    rollbackCalls,
    endSessionCalls,
    clearWorkflowCalls,
    broadcastCalls,
    killPidCalls,
    stopProgressCalls,
    activeProcesses,
    stopRequestedTasks,
    stopRequestModeByTask,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree verify-commit route", () => {
  it("worktree가 없으면 no_worktree 판정을 돌려준다", () => {
    const { db, getRoutes } = createHarness(new Map());
    try {
      const handler = getRoutes.get("/api/tasks/:id/verify-commit");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: "task-1" } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        ok: true,
        hasWorktree: false,
        hasCommit: false,
        verdict: "no_worktree",
      });
    } finally {
      db.close();
    }
  });

  it("커밋 없이 변경만 있으면 dirty_without_commit 판정을 돌려준다", () => {
    const repo = initRepo("climpire-verify-dirty-");
    tempDirs.push(repo);
    const taskId = "verify-dirty-0000-0000-0000-000000000000";
    const taskWorktrees = new Map<string, { worktreePath: string; branchName: string; projectPath: string }>();
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();

    fs.writeFileSync(path.join(String(worktreePath), "src-dirty.ts"), "export const dirty = true;\n", "utf8");

    const { db, getRoutes } = createHarness(taskWorktrees);
    try {
      const handler = getRoutes.get("/api/tasks/:id/verify-commit");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: taskId } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        ok: true,
        hasWorktree: true,
        hasCommit: false,
        hasUncommittedChanges: true,
        verdict: "dirty_without_commit",
      });
    } finally {
      db.close();
      tools.cleanupWorktree(repo, taskId);
    }
  });

  it("커밋된 코드 변경이 있으면 ok 판정을 돌려준다", () => {
    const repo = initRepo("climpire-verify-ok-");
    tempDirs.push(repo);
    const taskId = "verify-okay-0000-0000-0000-000000000000";
    const taskWorktrees = new Map<string, { worktreePath: string; branchName: string; projectPath: string }>();
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();

    const worktreeDir = String(worktreePath);
    fs.mkdirSync(path.join(worktreeDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, "src", "verify.ts"), "export const verified = true;\n", "utf8");
    runGit(worktreeDir, ["add", "."]);
    runGit(worktreeDir, ["commit", "-m", "feat: add verify file"]);

    const { db, getRoutes } = createHarness(taskWorktrees);
    try {
      const handler = getRoutes.get("/api/tasks/:id/verify-commit");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: taskId } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        ok: true,
        hasWorktree: true,
        hasCommit: true,
        verdict: "ok",
      });
      expect(res.payload).toMatchObject({
        files: ["src/verify.ts"],
      });
    } finally {
      db.close();
      tools.cleanupWorktree(repo, taskId);
    }
  });

  it("수동 merge 전에 최종 브랜치 검증 통과 로그를 남긴다", () => {
    const repo = initRepo("climpire-verify-merge-");
    tempDirs.push(repo);
    const taskId = "verify-merge-0000-0000-0000-000000000000";
    const taskWorktrees = new Map<string, { worktreePath: string; branchName: string; projectPath: string }>();
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();

    const worktreeDir = String(worktreePath);
    fs.mkdirSync(path.join(worktreeDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, "src", "verify.ts"), "export const verified = true;\n", "utf8");
    runGit(worktreeDir, ["add", "."]);
    runGit(worktreeDir, ["commit", "-m", "feat: ready for merge"]);

    const { db, postRoutes, appendLogCalls } = createHarness(taskWorktrees);
    try {
      const handler = postRoutes.get("/api/tasks/:id/merge");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: taskId } }, res);

      expect(res.statusCode).toBe(200);
      expect(appendLogCalls.some((entry) => entry.message.includes("Final branch verification: passed"))).toBe(true);
    } finally {
      db.close();
      tools.cleanupWorktree(repo, taskId);
    }
  });

  it("discard는 worktree를 rollback하고 task를 inbox로 되돌린다", () => {
    const taskId = "discard-task-0000";
    const taskWorktrees = new Map<string, { worktreePath: string; branchName: string; projectPath: string }>([
      [
        taskId,
        {
          worktreePath: "/tmp/worktree-discard",
          branchName: `climpire/${taskId}`,
          projectPath: "/tmp/project-discard",
        },
      ],
    ]);
    const harness = createHarness(taskWorktrees);
    try {
      harness.db.prepare("INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)").run(
        taskId,
        "Discard me",
        "review",
        1,
      );
      harness.db
        .prepare("INSERT INTO agents (id, status, current_task_id) VALUES (?, ?, ?)")
        .run("agent-1", "working", taskId);
      harness.db
        .prepare(
          "INSERT INTO task_retry_queue (task_id, attempt_count, next_run_at, last_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(taskId, 1, 1, "idle_timeout", 1, 1);
      harness.activeProcesses.set(taskId, { pid: 4321 });

      const handler = harness.postRoutes.get("/api/tasks/:id/discard");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: taskId } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({
        ok: true,
        message: "Worktree discarded and task reset to inbox",
        status: "inbox",
      });
      expect(harness.rollbackCalls).toEqual([{ taskId, reason: "manual_discard" }]);
      expect(harness.clearWorkflowCalls).toEqual([taskId]);
      expect(harness.endSessionCalls).toEqual([{ taskId, reason: "manual_discard" }]);
      expect(harness.killPidCalls).toEqual([4321]);
      expect(harness.stopProgressCalls).toEqual([taskId]);
      expect(harness.stopRequestedTasks.has(taskId)).toBe(true);
      expect(harness.stopRequestModeByTask.get(taskId)).toBe("cancel");
      expect(harness.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "inbox" });
      expect(harness.db.prepare("SELECT status, current_task_id FROM agents WHERE id = ?").get("agent-1")).toEqual({
        status: "idle",
        current_task_id: null,
      });
      expect(harness.db.prepare("SELECT * FROM task_retry_queue WHERE task_id = ?").get(taskId)).toBeUndefined();
      expect(harness.broadcastCalls.some((entry) => entry.event === "task_update")).toBe(true);
      expect(harness.broadcastCalls.some((entry) => entry.event === "agent_status")).toBe(true);
    } finally {
      harness.db.close();
    }
  });
});
