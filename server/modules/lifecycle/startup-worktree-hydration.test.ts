import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createWorktreeLifecycleTools, type WorktreeInfo } from "../workflow/core/worktree/lifecycle.ts";
import { hydrateStartupWorktrees } from "./startup-worktree-hydration.ts";
import {
  markTaskWorktreeCleaned,
  writeTaskWorktreeRef,
} from "../workflow/core/worktree/worktree-registry.ts";

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

function initDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      project_path TEXT,
      workflow_meta_json TEXT
    );
  `);
  return db;
}

function insertTask(db: DatabaseSync, taskId: string, status: string, projectPath: string): void {
  db.prepare("INSERT INTO tasks (id, status, project_path, workflow_meta_json) VALUES (?, ?, ?, NULL)")
    .run(taskId, status, projectPath);
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup worktree hydration", () => {
  it("hydrates only active worktree refs and skips cleaned refs", () => {
    const repo = initRepo("claw-startup-hydration-");
    tempDirs.push(repo);
    const db = initDb();
    const activeTaskId = "active01-0000-0000-0000-000000000000";
    const cleanedTaskId = "cleaned1-0000-0000-0000-000000000000";
    insertTask(db, activeTaskId, "pending", repo);
    insertTask(db, cleanedTaskId, "review", repo);

    const taskWorktrees = new Map<string, WorktreeInfo>();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    expect(tools.createWorktree(repo, activeTaskId, "Tester").success).toBe(true);
    expect(tools.createWorktree(repo, cleanedTaskId, "Tester").success).toBe(true);
    const activeInfo = taskWorktrees.get(activeTaskId)!;
    const cleanedInfo = taskWorktrees.get(cleanedTaskId)!;
    writeTaskWorktreeRef(db as any, { taskId: activeTaskId, info: activeInfo });
    writeTaskWorktreeRef(db as any, { taskId: cleanedTaskId, info: cleanedInfo });
    markTaskWorktreeCleaned(db as any, { taskId: cleanedTaskId, info: cleanedInfo });

    taskWorktrees.clear();

    const summary = hydrateStartupWorktrees({
      db,
      taskWorktrees,
    });

    expect(summary).toEqual({
      scannedCount: 1,
      hydratedCount: 1,
      skippedCleanedCount: 1,
      failedCount: 0,
    });
    expect(taskWorktrees.has(activeTaskId)).toBe(true);
    expect(taskWorktrees.has(cleanedTaskId)).toBe(false);
  });
});
