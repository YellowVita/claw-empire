import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export type WorktreeInfo = {
  worktreePath: string;
  branchName: string;
  projectPath: string;
};

type CreateWorktreeLifecycleToolsDeps = {
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  taskWorktrees: Map<string, WorktreeInfo>;
};

const WORKTREE_LOG_PREFIX = "worktree_path_guard";
const WORKTREE_ROOT_DIRNAME = ".climpire-worktrees";
const SHORT_ID_PATTERN = /^[A-Za-z0-9]{8}$/;
const WORKTREE_DIRNAME_PATTERN = /^([A-Za-z0-9]{8})(?:-(\d+))?$/;

export type ParsedWorktreeDirName = {
  shortId: string;
  suffix: number;
};

export type ManagedWorktreePathGuardResult =
  | {
      ok: true;
      projectRealPath: string;
      worktreeRootPath: string;
      targetPath?: string;
    }
  | {
      ok: false;
      reason: string;
    };

function canonicalPath(targetPath: string): string {
  return fs.realpathSync.native?.(targetPath) ?? fs.realpathSync(targetPath);
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isDirectChild(parentPath: string, childPath: string): boolean {
  return path.dirname(childPath) === parentPath;
}

function detectSymlinkOrJunction(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function getTaskShortId(taskId: string): string {
  const sanitized = taskId.replace(/[^A-Za-z0-9]/g, "");
  if (sanitized.length >= 8) return sanitized.slice(0, 8);
  const hashSuffix = createHash("sha256").update(taskId).digest("hex");
  return `${sanitized}${hashSuffix}`.slice(0, 8);
}

export function buildManagedWorktreeRoot(projectPath: string): string {
  return path.join(projectPath, WORKTREE_ROOT_DIRNAME);
}

export function buildManagedWorktreeDirName(shortId: string, suffix = 0): string {
  return suffix === 0 ? shortId : `${shortId}-${suffix}`;
}

export function buildManagedWorktreeBranchName(shortId: string, suffix = 0): string {
  return `climpire/${buildManagedWorktreeDirName(shortId, suffix)}`;
}

export function buildManagedWorktreePath(projectPath: string, shortId: string, suffix = 0): string {
  return path.join(buildManagedWorktreeRoot(projectPath), buildManagedWorktreeDirName(shortId, suffix));
}

export function parseManagedWorktreeDirName(dirName: string): ParsedWorktreeDirName | null {
  const match = dirName.match(WORKTREE_DIRNAME_PATTERN);
  if (!match) return null;
  const shortId = match[1] ?? "";
  if (!SHORT_ID_PATTERN.test(shortId)) return null;
  const suffix = Number(match[2] ?? "0");
  if (!Number.isInteger(suffix) || suffix < 0) return null;
  return { shortId, suffix };
}

export function guardManagedWorktreePath(projectPath: string, targetPath?: string): ManagedWorktreePathGuardResult {
  let projectRealPath: string;
  try {
    projectRealPath = canonicalPath(projectPath);
  } catch {
    return { ok: false, reason: `project_path_unresolved:${projectPath}` };
  }

  const worktreeRootPath = buildManagedWorktreeRoot(projectRealPath);
  const worktreeRootParent = path.dirname(worktreeRootPath);
  if (worktreeRootParent !== projectRealPath) {
    return { ok: false, reason: `worktree_root_escape:${worktreeRootPath}` };
  }

  if (fs.existsSync(worktreeRootPath) && detectSymlinkOrJunction(worktreeRootPath)) {
    return { ok: false, reason: `worktree_root_symlink:${worktreeRootPath}` };
  }

  if (!targetPath) {
    return { ok: true, projectRealPath, worktreeRootPath };
  }

  const projectInputPath = path.resolve(projectPath);
  const normalizedTargetPath = path.resolve(projectRealPath, path.relative(projectInputPath, path.resolve(targetPath)));
  if (!isDirectChild(worktreeRootPath, normalizedTargetPath)) {
    return { ok: false, reason: `target_not_direct_child:${normalizedTargetPath}` };
  }
  if (!isPathInside(worktreeRootPath, normalizedTargetPath)) {
    return { ok: false, reason: `target_outside_root:${normalizedTargetPath}` };
  }

  if (fs.existsSync(normalizedTargetPath)) {
    if (detectSymlinkOrJunction(normalizedTargetPath)) {
      return { ok: false, reason: `target_symlink:${normalizedTargetPath}` };
    }
    try {
      const targetRealPath = canonicalPath(normalizedTargetPath);
      if (!isPathInside(worktreeRootPath, targetRealPath)) {
        return { ok: false, reason: `target_realpath_escape:${targetRealPath}` };
      }
    } catch {
      return { ok: false, reason: `target_unresolved:${normalizedTargetPath}` };
    }
  }

  return {
    ok: true,
    projectRealPath,
    worktreeRootPath,
    targetPath: normalizedTargetPath,
  };
}

export function createWorktreeLifecycleTools(deps: CreateWorktreeLifecycleToolsDeps) {
  const { appendTaskLog, taskWorktrees } = deps;

  function isGitRepo(dir: string): boolean {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  function ensureWorktreeBootstrapRepo(projectPath: string, taskId: string): boolean {
    if (isGitRepo(projectPath)) return true;
    const shortId = getTaskShortId(taskId);
    try {
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        appendTaskLog(taskId, "system", `Git bootstrap skipped: invalid project path (${projectPath})`);
        return false;
      }
    } catch {
      appendTaskLog(taskId, "system", `Git bootstrap skipped: cannot access project path (${projectPath})`);
      return false;
    }

    try {
      appendTaskLog(
        taskId,
        "system",
        "Git repository not found. Bootstrapping local repository for worktree execution...",
      );

      try {
        execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "pipe", timeout: 10000 });
      } catch {
        execFileSync("git", ["init"], { cwd: projectPath, stdio: "pipe", timeout: 10000 });
      }

      const excludePath = path.join(projectPath, ".git", "info", "exclude");
      const baseIgnore = ["node_modules/", "dist/", ".climpire-worktrees/", ".climpire/", ".DS_Store", "*.log"];
      let existingExclude = "";
      try {
        existingExclude = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
      } catch {
        existingExclude = "";
      }
      const appendLines = baseIgnore.filter((line) => !existingExclude.includes(line));
      if (appendLines.length > 0) {
        const prefix = existingExclude && !existingExclude.endsWith("\n") ? "\n" : "";
        fs.appendFileSync(excludePath, `${prefix}${appendLines.join("\n")}\n`, "utf8");
      }

      const readConfig = (key: string): string => {
        try {
          return execFileSync("git", ["config", "--get", key], { cwd: projectPath, stdio: "pipe", timeout: 3000 })
            .toString()
            .trim();
        } catch {
          return "";
        }
      };
      if (!readConfig("user.name")) {
        execFileSync("git", ["config", "user.name", "Claw-Empire Bot"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 3000,
        });
      }
      if (!readConfig("user.email")) {
        execFileSync("git", ["config", "user.email", "claw-empire@local"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 3000,
        });
      }

      execFileSync("git", ["add", "-A"], { cwd: projectPath, stdio: "pipe", timeout: 20000 });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();
      if (staged) {
        execFileSync("git", ["commit", "-m", "chore: initialize project for Claw-Empire worktrees"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 20000,
        });
      } else {
        execFileSync("git", ["commit", "--allow-empty", "-m", "chore: initialize project for Claw-Empire worktrees"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 10000,
        });
      }

      appendTaskLog(taskId, "system", "Git repository initialized automatically for worktree execution.");
      console.log(`[Claw-Empire] Auto-initialized git repo for task ${shortId} at ${projectPath}`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTaskLog(taskId, "system", `Git bootstrap failed: ${msg}`);
      console.error(`[Claw-Empire] Failed git bootstrap for task ${shortId}: ${msg}`);
      return false;
    }
  }

  function createWorktree(projectPath: string, taskId: string, agentName: string, baseBranch?: string): string | null {
    if (!ensureWorktreeBootstrapRepo(projectPath, taskId)) return null;
    if (!isGitRepo(projectPath)) return null;

    const shortId = getTaskShortId(taskId);
    if (!SHORT_ID_PATTERN.test(shortId)) {
      appendTaskLog(taskId, "system", `${WORKTREE_LOG_PREFIX} create blocked: invalid_short_id:${shortId}`);
      return null;
    }
    const branchName = buildManagedWorktreeBranchName(shortId);
    const worktreeBase = buildManagedWorktreeRoot(projectPath);
    const worktreePath = buildManagedWorktreePath(projectPath, shortId);

    try {
      const rootGuard = guardManagedWorktreePath(projectPath);
      if (!rootGuard.ok) {
        appendTaskLog(taskId, "system", `${WORKTREE_LOG_PREFIX} create blocked: ${rootGuard.reason}`);
        return null;
      }
      fs.mkdirSync(worktreeBase, { recursive: true });
      execFileSync("git", ["worktree", "prune"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });

      // Get current branch/HEAD as base
      let base: string;
      if (baseBranch) {
        try {
          base = execFileSync("git", ["rev-parse", baseBranch], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
            .toString()
            .trim();
        } catch {
          base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
            .toString()
            .trim();
        }
      } else {
        base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, stdio: "pipe", timeout: 5000 })
          .toString()
          .trim();
      }

      const branchCandidates = [branchName, `${branchName}-1`, `${branchName}-2`, `${branchName}-3`];
      let created = false;
      let selectedBranch = branchName;
      let selectedWorktreePath = worktreePath;
      let lastError: unknown = null;

      for (let idx = 0; idx < branchCandidates.length; idx += 1) {
        const candidateBranch = branchCandidates[idx]!;
        const candidatePath = buildManagedWorktreePath(projectPath, shortId, idx);
        const candidateGuard = guardManagedWorktreePath(projectPath, candidatePath);
        if (!candidateGuard.ok) {
          lastError = new Error(candidateGuard.reason);
          appendTaskLog(taskId, "system", `${WORKTREE_LOG_PREFIX} create blocked: ${candidateGuard.reason}`);
          break;
        }
        try {
          if (fs.existsSync(candidatePath)) {
            fs.rmSync(candidatePath, { recursive: true, force: true });
          }
        } catch {
          // best effort cleanup
        }

        const branchExists = (() => {
          try {
            execFileSync("git", ["show-ref", "--verify", `refs/heads/${candidateBranch}`], {
              cwd: projectPath,
              stdio: "pipe",
              timeout: 5000,
            });
            return true;
          } catch {
            return false;
          }
        })();

        const addArgs = branchExists
          ? ["worktree", "add", candidatePath, candidateBranch]
          : ["worktree", "add", candidatePath, "-b", candidateBranch, base];

        try {
          execFileSync("git", addArgs, {
            cwd: projectPath,
            stdio: "pipe",
            timeout: 15000,
          });
          selectedBranch = candidateBranch;
          selectedWorktreePath = candidatePath;
          created = true;
          break;
        } catch (err: unknown) {
          lastError = err;
        }
      }

      if (!created) throw lastError instanceof Error ? lastError : new Error("worktree_add_failed");

      // Propagate .claude/skills into the worktree so agents can resolve installed skills
      try {
        const serverSkillsDir = path.join(process.cwd(), ".claude", "skills");
        if (fs.existsSync(serverSkillsDir)) {
          const wtClaudeDir = path.join(selectedWorktreePath, ".claude");
          const wtSkillsLink = path.join(wtClaudeDir, "skills");
          if (!fs.existsSync(wtSkillsLink)) {
            fs.mkdirSync(wtClaudeDir, { recursive: true });
            fs.symlinkSync(serverSkillsDir, wtSkillsLink, "junction");
          }
        }
      } catch {
        // best effort — skill propagation failure should not block execution
      }

      taskWorktrees.set(taskId, { worktreePath: selectedWorktreePath, branchName: selectedBranch, projectPath });
      console.log(
        `[Claw-Empire] Created worktree for task ${shortId}: ${selectedWorktreePath} (branch: ${selectedBranch}, agent: ${agentName})`,
      );
      return selectedWorktreePath;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Claw-Empire] Failed to create worktree for task ${shortId}: ${msg}`);
      return null;
    }
  }

  function cleanupWorktree(projectPath: string, taskId: string): void {
    const info = taskWorktrees.get(taskId);
    if (!info) return;

    const shortId = getTaskShortId(taskId);
    const targetGuard = guardManagedWorktreePath(projectPath, info.worktreePath);
    if (!targetGuard.ok) {
      appendTaskLog(taskId, "system", `${WORKTREE_LOG_PREFIX} cleanup blocked: ${targetGuard.reason}`);
      console.warn(`[Claw-Empire] ${WORKTREE_LOG_PREFIX} cleanup blocked for ${shortId}: ${targetGuard.reason}`);
      return;
    }

    try {
      execFileSync("git", ["worktree", "remove", info.worktreePath, "--force"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 10000,
      });
    } catch {
      console.warn(`[Claw-Empire] git worktree remove failed for ${shortId}, falling back to manual cleanup`);
      try {
        if (fs.existsSync(info.worktreePath)) {
          fs.rmSync(info.worktreePath, { recursive: true, force: true });
        }
        execFileSync("git", ["worktree", "prune"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }
    }

    try {
      execFileSync("git", ["branch", "-D", info.branchName], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      console.warn(`[Claw-Empire] Failed to delete branch ${info.branchName} — may need manual cleanup`);
    }

    taskWorktrees.delete(taskId);
    console.log(`[Claw-Empire] Cleaned up worktree for task ${shortId}`);
  }

  return {
    isGitRepo,
    createWorktree,
    cleanupWorktree,
  };
}
