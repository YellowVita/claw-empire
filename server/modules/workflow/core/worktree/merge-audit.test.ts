import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { encryptSecret } from "../../../../oauth/helpers.ts";
import { createWorktreeLifecycleTools } from "./lifecycle.ts";
import { createWorktreeMergeTools } from "./merge.ts";
import { autoCommitWorktreePendingChanges } from "./shared.ts";
import { writeTaskWorktreeRef } from "./worktree-registry.ts";

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

function initTaskDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      project_path TEXT,
      workflow_meta_json TEXT
    );
  `);
  return db;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree merge audit helpers", () => {
  it("returns commitSha when auto-commit creates a commit", () => {
    const repo = initRepo("claw-auto-commit-audit-");
    tempDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "seed\nupdated\n", "utf8");

    const result = autoCommitWorktreePendingChanges(
      "task-12345678",
      { worktreePath: repo, branchName: "climpire/12345678" },
      () => {},
    );

    expect(result.committed).toBe(true);
    expect(result.commitSha).toBe(runGit(repo, ["rev-parse", "HEAD"]));
  });

  it("keeps commitSha undefined when there is nothing to auto-commit", () => {
    const repo = initRepo("claw-auto-commit-clean-");
    tempDirs.push(repo);

    const result = autoCommitWorktreePendingChanges(
      "task-12345678",
      { worktreePath: repo, branchName: "climpire/12345678" },
      () => {},
    );

    expect(result.committed).toBe(false);
    expect(result.commitSha).toBeUndefined();
  });

  it("ignores runtime task artifacts during auto-commit", () => {
    const repo = initRepo("claw-auto-commit-runtime-tasks-");
    tempDirs.push(repo);
    fs.mkdirSync(path.join(repo, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".climpire", "runtime"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tasks", "todo.md"), "- local checklist\n", "utf8");
    fs.writeFileSync(path.join(repo, ".climpire", "runtime", "task-run-sheet-task123456.md"), "# readonly summary\n", "utf8");
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");

    const result = autoCommitWorktreePendingChanges(
      "task-12345678",
      { worktreePath: repo, branchName: "climpire/12345678" },
      () => {},
    );

    expect(result.committed).toBe(true);
    expect(runGit(repo, ["show", "--name-only", "--pretty=format:%s", "HEAD"])).toContain("feature.txt");
    expect(runGit(repo, ["show", "--name-only", "--pretty=format:%s", "HEAD"])).not.toContain("tasks/todo.md");
    expect(runGit(repo, ["show", "--name-only", "--pretty=format:%s", "HEAD"])).not.toContain(".climpire/runtime");
  });

  it("returns post-merge HEAD SHA and target branch on merge success", () => {
    const repo = initRepo("claw-merge-audit-");
    tempDirs.push(repo);
    runGit(repo, ["checkout", "-b", "climpire/12345678"]);
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "feature"]);
    runGit(repo, ["checkout", "main"]);

    const db = {
      prepare() {
        return {
          get() {
            return { title: "Ship feature", description: "Merge audit coverage" };
          },
        };
      },
    };

    const tools = createWorktreeMergeTools({
      db: db as any,
      taskWorktrees: new Map([
        [
          "task-12345678",
          {
            branchName: "climpire/12345678",
            projectPath: repo,
            worktreePath: repo,
          },
        ],
      ]),
      appendTaskLog: () => {},
      cleanupWorktree: () => {},
      resolveLang: () => "en",
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      pickL: (pool: any, lang: string) => pool?.[lang]?.[0] ?? pool?.en?.[0] ?? "",
    });

    const result = tools.mergeWorktree(repo, "task-12345678");

    expect(result.success).toBe(true);
    expect(result.targetBranch).toBe("main");
    expect(result.postMergeHeadSha).toBe(runGit(repo, ["rev-parse", "HEAD"]));
  });

  it("recovers worktree metadata on merge when the in-memory cache is empty", () => {
    const repo = initRepo("claw-merge-recover-");
    tempDirs.push(repo);
    const taskId = "recover01-0000-0000-0000-000000000000";
    const db = initTaskDb();
    db.prepare("INSERT INTO tasks (id, title, description, project_path, workflow_meta_json) VALUES (?, ?, ?, ?, NULL)")
      .run(taskId, "Recovered merge", "Recover from metadata", repo);

    const taskWorktrees = new Map();
    const lifecycleTools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });
    const createResult = lifecycleTools.createWorktree(repo, taskId, "Tester");
    expect(createResult.success).toBe(true);
    const info = taskWorktrees.get(taskId)!;
    fs.writeFileSync(path.join(info.worktreePath, "feature.txt"), "feature\n", "utf8");
    runGit(info.worktreePath, ["add", "."]);
    runGit(info.worktreePath, ["commit", "-m", "feature"]);
    writeTaskWorktreeRef(db as any, { taskId, info });
    taskWorktrees.clear();
    runGit(repo, ["checkout", "main"]);

    const tools = createWorktreeMergeTools({
      db: db as any,
      taskWorktrees,
      appendTaskLog: () => {},
      cleanupWorktree: () => {},
      resolveLang: () => "en",
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      pickL: (pool: any, lang: string) => pool?.[lang]?.[0] ?? pool?.en?.[0] ?? "",
    });

    const result = tools.mergeWorktree(repo, taskId);

    expect(result.success).toBe(true);
    expect(taskWorktrees.get(taskId)?.branchName).toBe(info.branchName);
    expect(fs.readFileSync(path.join(repo, "feature.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("feature\n");
  });

  it("task_branch_pr helper pushes the task branch and returns PR metadata", async () => {
    const repo = initRepo("claw-task-pr-");
    tempDirs.push(repo);
    runGit(repo, ["checkout", "-b", "climpire/12345678"]);
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "feature"]);

    const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), "claw-task-pr-remote-"));
    tempDirs.push(bareRemote);
    runGit(bareRemote, ["init", "--bare"]);
    runGit(repo, ["remote", "add", "origin", bareRemote]);

    const db = {
      prepare(sql: string) {
        if (sql.includes("SELECT title FROM tasks")) {
          return {
            get() {
              return { title: "Ship feature" };
            },
          };
        }
        if (sql.includes("oauth_accounts")) {
          return {
            get() {
              return { access_token_enc: encryptSecret("ghp_test_token") };
            },
          };
        }
        return {
          get() {
            return null;
          },
        };
      },
    };

    const tools = createWorktreeMergeTools({
      db: db as any,
      taskWorktrees: new Map([
        [
          "task-12345678",
          {
            branchName: "climpire/12345678",
            projectPath: repo,
            worktreePath: repo,
          },
        ],
      ]),
      appendTaskLog: () => {},
      cleanupWorktree: () => {},
      resolveLang: () => "en",
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      pickL: (pool: any, lang: string) => pool?.[lang]?.[0] ?? pool?.en?.[0] ?? "",
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/pulls?head=")) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/pulls") && init?.method === "POST") {
          return new Response(JSON.stringify({ html_url: "https://github.com/acme/repo/pull/21" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch,
    });

    try {
      const result = await tools.pushTaskBranchAndCreatePR(repo, "task-12345678", "acme/repo");
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          targetBranch: "dev",
          strategy: "task_branch_pr",
          prUrl: "https://github.com/acme/repo/pull/21",
        }),
      );
    } finally {
      /* no-op */
    }
  });

  it("squash ingest helper merges a child branch into the parent worktree and commits once", () => {
    const repo = initRepo("claw-child-ingest-");
    tempDirs.push(repo);

    runGit(repo, ["checkout", "-b", "climpire/parent0001"]);
    fs.writeFileSync(path.join(repo, "owner.txt"), "owner\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "owner"]);

    runGit(repo, ["checkout", "main"]);
    runGit(repo, ["checkout", "-b", "climpire/child0001"]);
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "child"]);

    runGit(repo, ["checkout", "climpire/parent0001"]);

    const tools = createWorktreeMergeTools({
      db: {
        prepare() {
          return {
            get() {
              return { title: "Parent task", description: "Parent ingest" };
            },
          };
        },
      } as any,
      taskWorktrees: new Map([
        [
          "parent-0001",
          {
            branchName: "climpire/parent0001",
            projectPath: repo,
            worktreePath: repo,
          },
        ],
        [
          "child-0001",
          {
            branchName: "climpire/child0001",
            projectPath: repo,
            worktreePath: repo,
          },
        ],
      ]),
      appendTaskLog: () => {},
      cleanupWorktree: () => {},
      resolveLang: () => "en",
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      pickL: (pool: any, lang: string) => pool?.[lang]?.[0] ?? pool?.en?.[0] ?? "",
    });

    const result = tools.ingestChildBranchIntoParent("parent-0001", "child-0001");

    expect(result.success).toBe(true);
    expect(result.ingestCommitSha).toBe(runGit(repo, ["rev-parse", "HEAD"]));
    expect(runGit(repo, ["show", "--stat", "--oneline", "-1"])).toContain(
      "chore: ingest child branch child000 (climpire/child0001)",
    );
    expect(fs.readFileSync(path.join(repo, "feature.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("feature\n");
  });

  it("squash ingest helper leaves non-runtime conflicts for AI resolution", () => {
    const repo = initRepo("claw-child-ingest-conflict-");
    tempDirs.push(repo);

    runGit(repo, ["checkout", "-b", "climpire/parent0002"]);
    fs.writeFileSync(path.join(repo, "shared.txt"), "parent\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "parent"]);

    runGit(repo, ["checkout", "main"]);
    fs.writeFileSync(path.join(repo, "shared.txt"), "main\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "main update"]);

    runGit(repo, ["checkout", "-b", "climpire/child0002"]);
    fs.writeFileSync(path.join(repo, "shared.txt"), "child\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "child update"]);

    runGit(repo, ["checkout", "climpire/parent0002"]);

    const tools = createWorktreeMergeTools({
      db: {
        prepare() {
          return {
            get() {
              return { title: "Parent task", description: "Parent ingest" };
            },
          };
        },
      } as any,
      taskWorktrees: new Map([
        [
          "parent-0002",
          {
            branchName: "climpire/parent0002",
            projectPath: repo,
            worktreePath: repo,
          },
        ],
        [
          "child-0002",
          {
            branchName: "climpire/child0002",
            projectPath: repo,
            worktreePath: repo,
          },
        ],
      ]),
      appendTaskLog: () => {},
      cleanupWorktree: () => {},
      resolveLang: () => "en",
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      pickL: (pool: any, lang: string) => pool?.[lang]?.[0] ?? pool?.en?.[0] ?? "",
    });

    const result = tools.ingestChildBranchIntoParent("parent-0002", "child-0002");

    expect(result.success).toBe(false);
    expect(result.conflicts).toContain("shared.txt");
    expect(result.needsAiResolution).toBe(true);
    expect(runGit(repo, ["status", "--short"])).toMatch(/shared\.txt/);
  });

  it("squash ingest helper auto-resolves runtime task artifact conflicts", () => {
    const repo = initRepo("claw-child-ingest-runtime-task-conflict-");
    tempDirs.push(repo);
    fs.mkdirSync(path.join(repo, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tasks", "todo.md"), "seed\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "seed tasks"]);

    runGit(repo, ["checkout", "-b", "climpire/parent0003"]);
    fs.writeFileSync(path.join(repo, "tasks", "todo.md"), "parent\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "parent todo"]);

    runGit(repo, ["checkout", "main"]);
    runGit(repo, ["checkout", "-b", "climpire/child0003"]);
    fs.writeFileSync(path.join(repo, "tasks", "todo.md"), "child\n", "utf8");
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "child todo"]);

    runGit(repo, ["checkout", "climpire/parent0003"]);

    const tools = createWorktreeMergeTools({
      db: {
        prepare() {
          return {
            get() {
              return { title: "Parent task", description: "Parent ingest" };
            },
          };
        },
      } as any,
      taskWorktrees: new Map([
        [
          "parent-0003",
          {
            branchName: "climpire/parent0003",
            projectPath: repo,
            worktreePath: repo,
          },
        ],
        [
          "child-0003",
          {
            branchName: "climpire/child0003",
            projectPath: repo,
            worktreePath: repo,
          },
        ],
      ]),
      appendTaskLog: () => {},
      cleanupWorktree: () => {},
      resolveLang: () => "en",
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      pickL: (pool: any, lang: string) => pool?.[lang]?.[0] ?? pool?.en?.[0] ?? "",
    });

    const result = tools.ingestChildBranchIntoParent("parent-0003", "child-0003");

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(repo, "feature.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("feature\n");
    expect(fs.readFileSync(path.join(repo, "tasks", "todo.md"), "utf8").replace(/\r\n/g, "\n")).toBe("parent\n");
  });
});
