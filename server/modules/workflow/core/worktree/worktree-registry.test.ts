import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createWorktreeLifecycleTools, type WorktreeInfo } from "./lifecycle.ts";
import {
  markTaskWorktreeCleaned,
  readTaskWorktreeRef,
  recoverTaskWorktreeInfo,
  writeTaskWorktreeRef,
} from "./worktree-registry.ts";

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

function insertTask(db: DatabaseSync, taskId: string, projectPath: string, workflowMetaJson: string | null = null): void {
  db.prepare("INSERT INTO tasks (id, status, project_path, workflow_meta_json) VALUES (?, 'pending', ?, ?)")
    .run(taskId, projectPath, workflowMetaJson);
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree registry", () => {
  it("writes and cleans worktree_ref metadata", () => {
    const repo = initRepo("claw-worktree-ref-");
    tempDirs.push(repo);
    const db = initDb();
    const taskId = "meta0001-0000-0000-0000-000000000000";
    insertTask(db, taskId, repo);

    const taskWorktrees = new Map<string, WorktreeInfo>();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    const result = tools.createWorktree(repo, taskId, "Tester");
    expect(result.success).toBe(true);
    const info = taskWorktrees.get(taskId)!;

    writeTaskWorktreeRef(db as any, { taskId, info });
    expect(readTaskWorktreeRef(db as any, taskId)).toEqual({
      branch_name: info.branchName,
      dir_name: path.basename(info.worktreePath),
      project_path: info.projectPath,
      state: "active",
    });

    markTaskWorktreeCleaned(db as any, { taskId, info });
    expect(readTaskWorktreeRef(db as any, taskId)?.state).toBe("cleaned");
  });

  it("recovers a parent/general worktree from worktree_ref metadata", () => {
    const repo = initRepo("claw-worktree-recover-ref-");
    tempDirs.push(repo);
    const db = initDb();
    const taskId = "recover01-0000-0000-0000-000000000000";
    insertTask(db, taskId, repo);

    const taskWorktrees = new Map<string, WorktreeInfo>();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });
    expect(tools.createWorktree(repo, taskId, "Tester").success).toBe(true);
    const info = taskWorktrees.get(taskId)!;
    writeTaskWorktreeRef(db as any, { taskId, info });
    taskWorktrees.clear();

    const recovered = recoverTaskWorktreeInfo(db as any, taskId, taskWorktrees);

    expect(recovered).toMatchObject({
      ok: true,
      source: "worktree_ref",
      backfilled: false,
    });
    expect(taskWorktrees.get(taskId)?.worktreePath).toBe(info.worktreePath);
  });

  it("recovers a child worktree from collab branch artifact metadata", () => {
    const repo = initRepo("claw-worktree-recover-child-");
    tempDirs.push(repo);
    const db = initDb();
    const taskId = "child001-0000-0000-0000-000000000000";
    insertTask(db, taskId, repo);

    const taskWorktrees = new Map<string, WorktreeInfo>();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });
    expect(tools.createWorktree(repo, taskId, "Tester").success).toBe(true);
    const info = taskWorktrees.get(taskId)!;
    taskWorktrees.clear();

    db.prepare(
      "UPDATE tasks SET workflow_meta_json = json_set('{}', '$.collab_branch_artifact', json(?)) WHERE id = ?",
    ).run(JSON.stringify({ branch_name: info.branchName }), taskId);

    const recovered = recoverTaskWorktreeInfo(db as any, taskId, taskWorktrees);

    expect(recovered).toMatchObject({
      ok: true,
      source: "child_artifact",
      backfilled: true,
    });
    expect(readTaskWorktreeRef(db as any, taskId)?.branch_name).toBe(info.branchName);
  });

  it("prefers the highest legacy suffix when backfilling missing metadata", () => {
    const repo = initRepo("claw-worktree-legacy-");
    tempDirs.push(repo);
    const db = initDb();
    const taskId = "legacy01-0000-0000-0000-000000000000";
    insertTask(db, taskId, repo);

    const root = path.join(repo, ".climpire-worktrees");
    fs.mkdirSync(root, { recursive: true });
    runGit(repo, ["worktree", "add", path.join(root, "legacy01-1"), "-b", "climpire/legacy01-1", "HEAD"]);
    runGit(repo, ["worktree", "add", path.join(root, "legacy01-2"), "-b", "climpire/legacy01-2", "HEAD"]);

    const taskWorktrees = new Map<string, WorktreeInfo>();
    const recovered = recoverTaskWorktreeInfo(db as any, taskId, taskWorktrees);

    expect(recovered).toMatchObject({
      ok: true,
      source: "legacy_scan",
      backfilled: true,
    });
    expect(taskWorktrees.get(taskId)?.branchName).toBe("climpire/legacy01-2");
    expect(readTaskWorktreeRef(db as any, taskId)?.dir_name).toBe("legacy01-2");
  });
});
