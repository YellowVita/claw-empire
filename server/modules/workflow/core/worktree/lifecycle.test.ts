import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorktreeLifecycleTools,
  getTaskShortId,
  guardManagedWorktreePath,
} from "./lifecycle.ts";

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

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  if (process.cwd() !== originalCwd) {
    process.chdir(originalCwd);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree lifecycle branch collision handling", () => {
  it("reuses existing task branch when branch already exists", () => {
    const repo = initRepo("climpire-wt-reuse-");
    tempDirs.push(repo);
    const shortId = "reuse001";
    const taskId = `${shortId}-0000-0000-0000-000000000000`;
    runGit(repo, ["branch", `climpire/${shortId}`]);

    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();
    const info = taskWorktrees.get(taskId);
    expect(info?.branchName).toBe(`climpire/${shortId}`);
    expect(fs.existsSync(String(info?.worktreePath || ""))).toBe(true);

    tools.cleanupWorktree(repo, taskId);
    expect(taskWorktrees.has(taskId)).toBe(false);
  });

  it("falls back to suffixed branch when existing branch is occupied in another worktree", () => {
    const repo = initRepo("climpire-wt-fallback-");
    tempDirs.push(repo);
    const shortId = "fallback";
    const baseBranch = `climpire/${shortId}`;
    const occupiedPath = path.join(repo, ".occupied-worktree");
    runGit(repo, ["worktree", "add", occupiedPath, "-b", baseBranch, "HEAD"]);

    const taskId = `${shortId}-0000-0000-0000-000000000000`;
    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();
    const info = taskWorktrees.get(taskId);
    expect(info?.branchName.startsWith(baseBranch)).toBe(true);
    expect(info?.branchName).not.toBe(baseBranch);

    tools.cleanupWorktree(repo, taskId);
    runGit(repo, ["worktree", "remove", occupiedPath, "--force"]);
    runGit(repo, ["branch", "-D", baseBranch]);
  }, 15000);
});

describe("worktree lifecycle path guard hardening", () => {
  it("blocks create when .climpire-worktrees is a junction", () => {
    const repo = initRepo("climpire-wt-root-junction-");
    const junctionTarget = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-root-target-"));
    tempDirs.push(repo, junctionTarget);

    fs.symlinkSync(junctionTarget, path.join(repo, ".climpire-worktrees"), "junction");

    const taskId = "safe1234-0000-0000-0000-000000000000";
    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    expect(tools.createWorktree(repo, taskId, "Tester")).toBeNull();
    expect(taskWorktrees.has(taskId)).toBe(false);
  });

  it("blocks create when the derived worktree path escapes the managed root", () => {
    const repo = initRepo("climpire-wt-escape-");
    tempDirs.push(repo);

    const escapedPath = path.join(repo, "..", "escaped-worktree");
    expect(guardManagedWorktreePath(repo, escapedPath)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("target_not_direct_child"),
    });
  });

  it("blocks cleanup when the tracked worktree path is outside the managed root", () => {
    const repo = initRepo("climpire-wt-cleanup-outside-");
    const escapedDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-escaped-"));
    tempDirs.push(repo, escapedDir);
    fs.writeFileSync(path.join(escapedDir, "keep.txt"), "do-not-delete", "utf8");

    const taskId = "outside1-0000-0000-0000-000000000000";
    const taskWorktrees = new Map([
      [
        taskId,
        {
          branchName: "climpire/outside1",
          projectPath: repo,
          worktreePath: escapedDir,
        },
      ],
    ]);
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    tools.cleanupWorktree(repo, taskId);

    expect(fs.existsSync(escapedDir)).toBe(true);
    expect(taskWorktrees.has(taskId)).toBe(true);
  });

  it("blocks cleanup when the tracked worktree path is a junction", () => {
    const repo = initRepo("climpire-wt-cleanup-junction-");
    const managedRoot = path.join(repo, ".climpire-worktrees");
    const junctionTarget = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-cleanup-target-"));
    tempDirs.push(repo, junctionTarget);
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.writeFileSync(path.join(junctionTarget, "keep.txt"), "do-not-delete", "utf8");

    const taskId = "linksafe-0000-0000-0000-000000000000";
    const junctionPath = path.join(managedRoot, "linksafe");
    fs.symlinkSync(junctionTarget, junctionPath, "junction");

    const taskWorktrees = new Map([
      [
        taskId,
        {
          branchName: "climpire/linksafe",
          projectPath: repo,
          worktreePath: junctionPath,
        },
      ],
    ]);
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    tools.cleanupWorktree(repo, taskId);

    expect(fs.lstatSync(junctionPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(junctionTarget, "keep.txt"))).toBe(true);
    expect(taskWorktrees.has(taskId)).toBe(true);
  });

  it("keeps .claude/skills junction propagation working under the new guard", () => {
    const repo = initRepo("climpire-wt-skills-");
    const harness = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-harness-"));
    tempDirs.push(repo, harness);
    fs.mkdirSync(path.join(harness, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(harness, ".claude", "skills", "README.md"), "skill", "utf8");

    const taskId = "skills01-0000-0000-0000-000000000000";
    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    process.chdir(harness);
    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    process.chdir(originalCwd);

    expect(worktreePath).toBeTruthy();
    const propagatedPath = path.join(String(worktreePath), ".claude", "skills");
    expect(fs.existsSync(propagatedPath)).toBe(true);
    expect(fs.lstatSync(propagatedPath).isSymbolicLink()).toBe(true);

    tools.cleanupWorktree(repo, taskId);
  });

  it("sanitizes non-alphanumeric task ids into a valid 8-character short id", () => {
    const taskId = "verify-dirty-0000-0000-0000-000000000000";
    const shortId = getTaskShortId(taskId);

    expect(shortId).toHaveLength(8);
    expect(shortId).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(shortId).toBe("verifydi");
  });

  it("pads short sanitized ids with stable hash material", () => {
    const shortId = getTaskShortId("a-1");

    expect(shortId).toHaveLength(8);
    expect(shortId).toMatch(/^a1[a-f0-9]{6}$/);
  });

  it("creates a worktree even when the task id contains separators", () => {
    const repo = initRepo("climpire-wt-sanitized-");
    tempDirs.push(repo);

    const taskId = "verify-dirty-0000-0000-0000-000000000000";
    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();
    expect(taskWorktrees.get(taskId)?.branchName).toBe(`climpire/${getTaskShortId(taskId)}`);

    tools.cleanupWorktree(repo, taskId);
  });
});
