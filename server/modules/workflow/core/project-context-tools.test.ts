import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectContextTools } from "./project-context-tools.ts";

const tempDirs: string[] = [];

const noopDb = {
  prepare: () => ({
    get: () => undefined,
    all: () => [],
  }),
};

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    stdio: "pipe",
    timeout: 5000,
  })
    .toString()
    .trim();
}

function createTempRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "claw-empire-project-context-"));
  tempDirs.push(repoPath);

  fs.writeFileSync(path.join(repoPath, "README.md"), "# Initial Context\nhello\n", "utf8");
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["add", "README.md"]);
  execFileSync(
    "git",
    ["-c", "user.name=Claw Empire Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
    {
      cwd: repoPath,
      stdio: "pipe",
      timeout: 5000,
    },
  );

  return repoPath;
}

function isGitRepo(projectPath: string): boolean {
  try {
    return runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const repoPath = tempDirs.pop();
    if (!repoPath) continue;
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

describe("createProjectContextTools", () => {
  it("invalidates cached context when tracked files change without a new commit", () => {
    const repoPath = createTempRepo();
    const tools = createProjectContextTools({
      db: noopDb as any,
      isGitRepo,
      taskWorktrees: new Map(),
    });

    const first = tools.generateProjectContext(repoPath);
    expect(first).toContain("# Initial Context");

    fs.writeFileSync(path.join(repoPath, "README.md"), "# Updated Context\nworld\n", "utf8");

    const second = tools.generateProjectContext(repoPath);
    expect(second).toContain("# Updated Context");
    expect(second).not.toContain("# Initial Context");
  });

  it("reuses cached context when only generated .climpire files exist", async () => {
    const repoPath = createTempRepo();
    const tools = createProjectContextTools({
      db: noopDb as any,
      isGitRepo,
      taskWorktrees: new Map(),
    });

    const first = tools.generateProjectContext(repoPath);
    const contextPath = path.join(repoPath, ".climpire", "project-context.md");
    const firstMtime = fs.statSync(contextPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = tools.generateProjectContext(repoPath);
    const secondMtime = fs.statSync(contextPath).mtimeMs;

    expect(second).toBe(first);
    expect(secondMtime).toBe(firstMtime);
  });

  it("caps large directory traversal and reports summarized counts", () => {
    const repoPath = createTempRepo();
    const srcPath = path.join(repoPath, "src");
    fs.mkdirSync(srcPath, { recursive: true });
    for (let i = 0; i < 620; i += 1) {
      const filename = `module-${String(i).padStart(3, "0")}.ts`;
      fs.writeFileSync(path.join(srcPath, filename), `export const value${i} = ${i};\n`, "utf8");
    }

    const tools = createProjectContextTools({
      db: noopDb as any,
      isGitRepo,
      taskWorktrees: new Map(),
    });

    const context = tools.generateProjectContext(repoPath);

    expect(context).toContain("src/ (500+ files)");
    expect(context).toContain("... (580 more entries)");
  });
});
