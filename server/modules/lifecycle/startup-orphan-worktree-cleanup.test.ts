import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupStartupOrphanWorktrees } from "../lifecycle.ts";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 15_000 }).toString().trim();
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
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      project_path TEXT
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      project_path TEXT
    );
  `);
  return db;
}

function insertProject(db: DatabaseSync, id: string, projectPath: string): void {
  db.prepare("INSERT INTO projects (id, project_path) VALUES (?, ?)").run(id, projectPath);
}

function insertTask(db: DatabaseSync, id: string, status: string, projectPath: string): void {
  db.prepare("INSERT INTO tasks (id, status, project_path) VALUES (?, ?, ?)").run(id, status, projectPath);
}

function createManagedWorktree(repo: string, dirName: string): string {
  const worktreePath = path.join(repo, ".climpire-worktrees", dirName);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(repo, ["worktree", "add", worktreePath, "-b", `climpire/${dirName}`, "HEAD"]);
  return worktreePath;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup orphan worktree cleanup", () => {
  it("auto-cleans a unique done task worktree and prunes before removal", () => {
    const db = initDb();
    const repo = initRepo("climpire-startup-done-");
    tempDirs.push(repo);

    insertProject(db, "project-1", repo);
    insertTask(db, "done1234-0000-0000-0000-000000000000", "done", repo);
    const worktreePath = createManagedWorktree(repo, "done1234");

    const gitCalls: string[] = [];
    const summary = cleanupStartupOrphanWorktrees({
      db,
      runGit: (cwd, args) => {
        gitCalls.push(`${cwd}:${args.join(" ")}`);
        execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
      },
    });

    expect(summary.cleanedCount).toBe(1);
    expect(fs.existsSync(worktreePath)).toBe(false);
    const pruneIndex = gitCalls.findIndex((entry) => entry.endsWith("worktree prune"));
    const removeIndex = gitCalls.findIndex((entry) => entry.includes(`worktree remove ${worktreePath} --force`));
    expect(pruneIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(pruneIndex);
    expect(runGit(repo, ["branch", "--list", "climpire/done1234"])).toBe("");
  });

  it("auto-cleans a unique cancelled suffixed worktree", () => {
    const db = initDb();
    const repo = initRepo("climpire-startup-cancelled-");
    tempDirs.push(repo);

    insertProject(db, "project-1", repo);
    insertTask(db, "cancel01-0000-0000-0000-000000000000", "cancelled", repo);
    const worktreePath = createManagedWorktree(repo, "cancel01-1");

    const summary = cleanupStartupOrphanWorktrees({ db });

    expect(summary.cleanedCount).toBe(1);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(runGit(repo, ["branch", "--list", "climpire/cancel01-1"])).toBe("");
  });

  it("keeps pending and inbox worktrees for post-recovery task states", () => {
    const db = initDb();
    const repo = initRepo("climpire-startup-pending-");
    tempDirs.push(repo);

    insertProject(db, "project-1", repo);
    insertTask(db, "pend0001-0000-0000-0000-000000000000", "pending", repo);
    insertTask(db, "inbox001-0000-0000-0000-000000000000", "inbox", repo);
    const pendingPath = createManagedWorktree(repo, "pend0001");
    const inboxPath = createManagedWorktree(repo, "inbox001");

    const summary = cleanupStartupOrphanWorktrees({ db });

    expect(summary.cleanedCount).toBe(0);
    expect(summary.deferredReasons.status_pending).toBe(1);
    expect(summary.deferredReasons.status_inbox).toBe(1);
    expect(fs.existsSync(pendingPath)).toBe(true);
    expect(fs.existsSync(inboxPath)).toBe(true);
  });

  it("keeps worktrees when short id matching is ambiguous", () => {
    const db = initDb();
    const repo = initRepo("climpire-startup-ambiguous-");
    tempDirs.push(repo);

    insertProject(db, "project-1", repo);
    insertTask(db, "shared01-0000-0000-0000-000000000000", "done", repo);
    insertTask(db, "shared01-1111-1111-1111-111111111111", "cancelled", repo);
    const worktreePath = createManagedWorktree(repo, "shared01");

    const summary = cleanupStartupOrphanWorktrees({ db });

    expect(summary.cleanedCount).toBe(0);
    expect(summary.deferredReasons.task_ambiguous).toBe(1);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it("keeps worktrees with no matching task", () => {
    const db = initDb();
    const repo = initRepo("climpire-startup-missing-");
    tempDirs.push(repo);

    insertProject(db, "project-1", repo);
    const worktreePath = createManagedWorktree(repo, "ghost001");

    const summary = cleanupStartupOrphanWorktrees({ db });

    expect(summary.cleanedCount).toBe(0);
    expect(summary.deferredReasons.task_not_found).toBe(1);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it("defers the whole project when the managed root is a junction", () => {
    const db = initDb();
    const repo = initRepo("climpire-startup-junction-");
    const junctionTarget = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-startup-junction-target-"));
    tempDirs.push(repo, junctionTarget);

    insertProject(db, "project-1", repo);
    const managedRoot = path.join(repo, ".climpire-worktrees");
    fs.symlinkSync(junctionTarget, managedRoot, "junction");
    fs.mkdirSync(path.join(junctionTarget, "done1234"), { recursive: true });

    const summary = cleanupStartupOrphanWorktrees({ db });

    expect(summary.cleanedCount).toBe(0);
    expect(summary.deferredReasons.project_guard_failed).toBe(1);
    expect(fs.existsSync(path.join(junctionTarget, "done1234"))).toBe(true);
  });
});
