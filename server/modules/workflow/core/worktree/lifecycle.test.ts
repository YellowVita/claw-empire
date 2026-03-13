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
const originalAllowedRoots = process.env.PROJECT_PATH_ALLOWED_ROOTS;

afterEach(() => {
  if (process.cwd() !== originalCwd) {
    process.chdir(originalCwd);
  }
  if (originalAllowedRoots === undefined) {
    delete process.env.PROJECT_PATH_ALLOWED_ROOTS;
  } else {
    process.env.PROJECT_PATH_ALLOWED_ROOTS = originalAllowedRoots;
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

    const result = tools.createWorktree(repo, taskId, "Tester");
    expect(result.success).toBe(true);
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

    const result = tools.createWorktree(repo, taskId, "Tester");
    expect(result.success).toBe(true);
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

    expect(tools.createWorktree(repo, taskId, "Tester")).toMatchObject({ success: false });
    expect(taskWorktrees.has(taskId)).toBe(false);
  });

  it("blocks create when project realpath escapes allowed roots", () => {
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-allowed-"));
    const outsideRoot = initRepo("climpire-wt-outside-");
    const linkedRepo = path.join(allowedRoot, "linked-repo");
    tempDirs.push(allowedRoot, outsideRoot);
    fs.symlinkSync(outsideRoot, linkedRepo, "junction");
    process.env.PROJECT_PATH_ALLOWED_ROOTS = allowedRoot;

    const taskId = "realroot1-0000-0000-0000-000000000000";
    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    expect(tools.createWorktree(linkedRepo, taskId, "Tester")).toMatchObject({ success: false });
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
    const result = tools.createWorktree(repo, taskId, "Tester");
    process.chdir(originalCwd);

    expect(result.success).toBe(true);
    const propagatedPath = path.join(String(result.success ? result.worktreePath : ""), ".claude", "skills");
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

    const result = tools.createWorktree(repo, taskId, "Tester");
    expect(result.success).toBe(true);
    expect(taskWorktrees.get(taskId)?.branchName).toBe(`climpire/${getTaskShortId(taskId)}`);

    tools.cleanupWorktree(repo, taskId);
  });

  it("non-git 프로젝트는 정책 opt-in 없으면 bootstrap 없이 차단한다", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-no-bootstrap-"));
    tempDirs.push(projectDir);
    const logs: string[] = [];
    const taskId = "nogit001-0000-0000-0000-000000000000";
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: (_taskId, _kind, message) => logs.push(message),
      taskWorktrees: new Map(),
    });

    const result = tools.createWorktree(projectDir, taskId, "Tester");

    expect(result).toMatchObject({
      success: false,
      failureCode: "git_bootstrap_disabled",
      manualSetupCommands: ['git init', 'git add -A', 'git commit -m "initial commit"'],
    });
    expect(fs.existsSync(path.join(projectDir, ".git"))).toBe(false);
    expect(logs.some((entry) => entry.includes("Auto git bootstrap is disabled by project policy"))).toBe(true);
  });

  it("non-git 프로젝트도 gitBootstrap opt-in이 있으면 bootstrap 후 worktree를 만든다", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-bootstrap-optin-"));
    const taskId = "optin001-0000-0000-0000-000000000000";
    tempDirs.push(projectDir);
    fs.writeFileSync(
      path.join(projectDir, "WORKFLOW.md"),
      `---
gitBootstrap:
  allowAutoGitBootstrap: true
---
`,
      "utf8",
    );
    fs.writeFileSync(path.join(projectDir, "README.md"), "bootstrap me\n", "utf8");
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees: new Map(),
    });

    const result = tools.createWorktree(projectDir, taskId, "Tester");

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(projectDir, ".git"))).toBe(true);
    runGit(projectDir, ["rev-parse", "HEAD"]);
    tools.cleanupWorktree(projectDir, taskId);
  });
});
