import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "path";
import { execFileSync } from "node:child_process";

import { findTasksByShortId, listDistinctProjectPaths } from "../../db/queries/worktree-queries.ts";
import {
  buildManagedWorktreeBranchName,
  guardManagedWorktreePath,
  parseManagedWorktreeDirName,
} from "../workflow/core/worktree/lifecycle.ts";

export type StartupOrphanWorktreeCleanupSummary = {
  scannedProjects: number;
  candidateCount: number;
  pruneSuccessCount: number;
  pruneFailureCount: number;
  cleanedCount: number;
  deferredCount: number;
  deferredReasons: Record<string, number>;
};

export interface StartupOrphanWorktreeCleanupDeps {
  db: DatabaseSync;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  runGit?: (cwd: string, args: string[]) => void;
}

const STARTUP_WORKTREE_CLEANUP_PREFIX = "startup_orphan_worktree_cleanup";
const STARTUP_WORKTREE_AUTOCLEAN_STATUSES = new Set(["done", "cancelled"]);
const STARTUP_WORKTREE_DEFER_STATUSES = new Set([
  "inbox",
  "planned",
  "collaborating",
  "in_progress",
  "review",
  "pending",
]);

function incrementReason(summary: StartupOrphanWorktreeCleanupSummary, reason: string): void {
  summary.deferredCount += 1;
  summary.deferredReasons[reason] = (summary.deferredReasons[reason] ?? 0) + 1;
}

export function cleanupStartupOrphanWorktrees(
  deps: StartupOrphanWorktreeCleanupDeps,
): StartupOrphanWorktreeCleanupSummary {
  const {
    db,
    log = (message: string) => console.log(message),
    warn = (message: string) => console.warn(message),
    runGit = (cwd: string, args: string[]) => {
      execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
    },
  } = deps;

  const summary: StartupOrphanWorktreeCleanupSummary = {
    scannedProjects: 0,
    candidateCount: 0,
    pruneSuccessCount: 0,
    pruneFailureCount: 0,
    cleanedCount: 0,
    deferredCount: 0,
    deferredReasons: {},
  };

  for (const projectPath of listDistinctProjectPaths(db)) {
    summary.scannedProjects += 1;

    const rootGuard = guardManagedWorktreePath(projectPath);
    if (!rootGuard.ok) {
      incrementReason(summary, "project_guard_failed");
      warn(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} project deferred (${projectPath}): ${rootGuard.reason}`);
      continue;
    }

    const worktreeRoot = rootGuard.worktreeRootPath;
    if (!fs.existsSync(worktreeRoot)) continue;

    try {
      runGit(projectPath, ["worktree", "prune"]);
      summary.pruneSuccessCount += 1;
    } catch (error) {
      summary.pruneFailureCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      warn(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} prune failed (${projectPath}): ${message}`);
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(worktreeRoot, { withFileTypes: true });
    } catch (error) {
      incrementReason(summary, "readdir_failed");
      const message = error instanceof Error ? error.message : String(error);
      warn(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} scan failed (${worktreeRoot}): ${message}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      summary.candidateCount += 1;

      const parsed = parseManagedWorktreeDirName(entry.name);
      if (!parsed) {
        incrementReason(summary, "invalid_dir_name");
        warn(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} deferred (${entry.name}): invalid_dir_name`);
        continue;
      }

      const candidatePath = path.join(worktreeRoot, entry.name);
      const targetGuard = guardManagedWorktreePath(projectPath, candidatePath);
      if (!targetGuard.ok) {
        incrementReason(summary, "target_guard_failed");
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} deferred (${candidatePath}): ${targetGuard.reason}`,
        );
        continue;
      }

      const matchedTasks = findTasksByShortId(db, parsed.shortId);
      if (matchedTasks.length !== 1) {
        incrementReason(summary, matchedTasks.length === 0 ? "task_not_found" : "task_ambiguous");
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} deferred (${entry.name}): short_id_match_count=${matchedTasks.length}`,
        );
        continue;
      }

      const task = matchedTasks[0]!;
      if (!STARTUP_WORKTREE_AUTOCLEAN_STATUSES.has(task.status)) {
        const reason = STARTUP_WORKTREE_DEFER_STATUSES.has(task.status) ? `status_${task.status}` : "status_other";
        incrementReason(summary, reason);
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} deferred (${entry.name}): task ${task.id} status=${task.status}`,
        );
        continue;
      }

      try {
        runGit(projectPath, ["worktree", "remove", candidatePath, "--force"]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} git remove failed (${candidatePath}): ${message}; falling back to manual cleanup`,
        );
        try {
          if (fs.existsSync(candidatePath)) {
            fs.rmSync(candidatePath, { recursive: true, force: true });
          }
          runGit(projectPath, ["worktree", "prune"]);
        } catch (fallbackError) {
          incrementReason(summary, "cleanup_failed");
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          warn(
            `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} manual cleanup failed (${candidatePath}): ${fallbackMessage}`,
          );
          continue;
        }
      }

      try {
        runGit(projectPath, ["branch", "-D", buildManagedWorktreeBranchName(parsed.shortId, parsed.suffix)]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} branch cleanup warning (${entry.name}): ${message}`,
        );
      }

      summary.cleanedCount += 1;
      log(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} cleaned ${candidatePath} for task ${task.id}`);
    }
  }

  log(
    `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} summary projects=${summary.scannedProjects} candidates=${summary.candidateCount} prune_ok=${summary.pruneSuccessCount} prune_failed=${summary.pruneFailureCount} cleaned=${summary.cleanedCount} deferred=${summary.deferredCount}`,
  );
  return summary;
}
