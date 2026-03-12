import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { createWorktreeMergeTools } from "./merge.ts";
import { autoCommitWorktreePendingChanges } from "./shared.ts";

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
});
