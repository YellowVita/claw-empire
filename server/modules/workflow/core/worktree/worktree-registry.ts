import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

import {
  buildManagedWorktreeRoot,
  getTaskShortId,
  guardManagedWorktreePath,
  parseManagedWorktreeDirName,
  type WorktreeInfo,
} from "./lifecycle.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

export type TaskWorktreeRefState = "active" | "cleaned";

export type TaskWorktreeRef = {
  branch_name: string;
  dir_name: string;
  project_path: string;
  state: TaskWorktreeRefState;
};

type TaskMetaRow = {
  project_path: string | null;
  workflow_meta_json: string | null;
};

export type TaskWorktreeRecoverySource = "cache" | "worktree_ref" | "child_artifact" | "legacy_scan";

export type TaskWorktreeRecoveryFailureReason =
  | "not_found"
  | "cleaned"
  | "missing_project_path"
  | "project_guard_failed"
  | "missing_path"
  | "branch_mismatch"
  | "invalid_git_worktree"
  | "no_candidate"
  | "multiple_candidates";

export type TaskWorktreeRecoveryResult =
  | {
      ok: true;
      info: WorktreeInfo;
      source: TaskWorktreeRecoverySource;
      backfilled: boolean;
    }
  | {
      ok: false;
      reason: TaskWorktreeRecoveryFailureReason;
      detail?: string;
    };

type RecoverTaskWorktreeInfoOptions = {
  projectPath?: string | null;
  allowChildArtifactFallback?: boolean;
  allowLegacyScan?: boolean;
  backfillRef?: boolean;
};

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseWorkflowMetaObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readTaskMetaRow(db: DbLike, taskId: string): TaskMetaRow | null {
  try {
    const row = db
      .prepare("SELECT project_path, workflow_meta_json FROM tasks WHERE id = ?")
      .get(taskId) as TaskMetaRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function normalizeTaskWorktreeRef(raw: unknown): TaskWorktreeRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const branchName = normalizeText(source.branch_name);
  const dirName = normalizeText(source.dir_name);
  const projectPath = normalizeText(source.project_path);
  const state = normalizeText(source.state);
  if (!branchName || !dirName || !projectPath) return null;
  if (state !== "active" && state !== "cleaned") return null;
  return {
    branch_name: branchName,
    dir_name: dirName,
    project_path: projectPath,
    state,
  };
}

function upsertTaskWorktreeRef(db: DbLike, taskId: string, worktreeRef: TaskWorktreeRef): void {
  try {
    db.prepare(
      `
        UPDATE tasks
        SET workflow_meta_json = json_set(
              CASE
                WHEN json_valid(workflow_meta_json) THEN workflow_meta_json
                ELSE '{}'
              END,
              '$.worktree_ref',
              json(?)
            )
        WHERE id = ?
      `,
    ).run(JSON.stringify(worktreeRef), taskId);
  } catch {
    // Legacy harnesses may not define workflow_meta_json yet.
  }
}

function readWorktreeRefFromTaskMeta(row: TaskMetaRow | null): TaskWorktreeRef | null {
  if (!row) return null;
  const workflowMeta = parseWorkflowMetaObject(row.workflow_meta_json);
  return normalizeTaskWorktreeRef(workflowMeta.worktree_ref);
}

function readChildBranchNameFromTaskMeta(row: TaskMetaRow | null): string | null {
  if (!row) return null;
  const workflowMeta = parseWorkflowMetaObject(row.workflow_meta_json);
  const collab = workflowMeta.collab_branch_artifact;
  if (!collab || typeof collab !== "object" || Array.isArray(collab)) return null;
  return normalizeText((collab as Record<string, unknown>).branch_name);
}

function readCurrentBranch(worktreePath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function resolveCandidateInfo(
  projectPath: string,
  dirName: string,
  expectedBranchName: string,
): { ok: true; info: WorktreeInfo } | { ok: false; reason: TaskWorktreeRecoveryFailureReason; detail?: string } {
  const candidatePath = path.join(buildManagedWorktreeRoot(projectPath), dirName);
  const guard = guardManagedWorktreePath(projectPath, candidatePath);
  if (!guard.ok) {
    return { ok: false, reason: "project_guard_failed", detail: guard.reason };
  }
  if (!fs.existsSync(candidatePath)) {
    return { ok: false, reason: "missing_path", detail: candidatePath };
  }
  const branchName = readCurrentBranch(candidatePath);
  if (!branchName) {
    return { ok: false, reason: "invalid_git_worktree", detail: candidatePath };
  }
  if (branchName !== expectedBranchName) {
    return {
      ok: false,
      reason: "branch_mismatch",
      detail: `${candidatePath}:${branchName}!=${expectedBranchName}`,
    };
  }
  return {
    ok: true,
    info: {
      worktreePath: candidatePath,
      branchName,
      projectPath: guard.projectRealPath,
    },
  };
}

export function writeTaskWorktreeRef(
  db: DbLike,
  input: {
    taskId: string;
    info: WorktreeInfo;
  },
): void {
  upsertTaskWorktreeRef(db, input.taskId, {
    branch_name: input.info.branchName,
    dir_name: path.basename(input.info.worktreePath),
    project_path: input.info.projectPath,
    state: "active",
  });
}

export function markTaskWorktreeCleaned(
  db: DbLike,
  input: {
    taskId: string;
    info?: WorktreeInfo | null;
  },
): void {
  const existing = readTaskWorktreeRef(db, input.taskId);
  const info = input.info ?? null;
  const branchName = existing?.branch_name ?? info?.branchName ?? null;
  const dirName = existing?.dir_name ?? (info ? path.basename(info.worktreePath) : null);
  const projectPath = existing?.project_path ?? info?.projectPath ?? null;
  if (!branchName || !dirName || !projectPath) return;
  upsertTaskWorktreeRef(db, input.taskId, {
    branch_name: branchName,
    dir_name: dirName,
    project_path: projectPath,
    state: "cleaned",
  });
}

export function readTaskWorktreeRef(db: DbLike, taskId: string): TaskWorktreeRef | null {
  return readWorktreeRefFromTaskMeta(readTaskMetaRow(db, taskId));
}

export function recoverTaskWorktreeInfo(
  db: DbLike,
  taskId: string,
  taskWorktrees: Map<string, WorktreeInfo>,
  options: RecoverTaskWorktreeInfoOptions = {},
): TaskWorktreeRecoveryResult {
  const cached = taskWorktrees.get(taskId);
  if (cached) {
    return { ok: true, info: cached, source: "cache", backfilled: false };
  }

  const row = readTaskMetaRow(db, taskId);
  if (!row) return { ok: false, reason: "not_found" };

  const worktreeRef = readWorktreeRefFromTaskMeta(row);
  if (worktreeRef?.state === "cleaned") {
    return { ok: false, reason: "cleaned", detail: worktreeRef.branch_name };
  }

  const effectiveProjectPath =
    normalizeText(options.projectPath) ?? worktreeRef?.project_path ?? normalizeText(row.project_path);
  if (!effectiveProjectPath) {
    return { ok: false, reason: "missing_project_path" };
  }

  const rootGuard = guardManagedWorktreePath(effectiveProjectPath);
  if (!rootGuard.ok) {
    return { ok: false, reason: "project_guard_failed", detail: rootGuard.reason };
  }
  const projectPath = rootGuard.projectRealPath;

  if (worktreeRef?.state === "active") {
    const recovered = resolveCandidateInfo(projectPath, worktreeRef.dir_name, worktreeRef.branch_name);
    if (recovered.ok) {
      taskWorktrees.set(taskId, recovered.info);
      return { ok: true, info: recovered.info, source: "worktree_ref", backfilled: false };
    }
  }

  if (options.allowChildArtifactFallback !== false) {
    const childBranchName = readChildBranchNameFromTaskMeta(row);
    if (childBranchName?.startsWith("climpire/")) {
      const dirName = childBranchName.slice("climpire/".length);
      if (dirName) {
        const recovered = resolveCandidateInfo(projectPath, dirName, childBranchName);
        if (recovered.ok) {
          taskWorktrees.set(taskId, recovered.info);
          const shouldBackfill = options.backfillRef !== false && !worktreeRef;
          if (shouldBackfill) {
            writeTaskWorktreeRef(db, { taskId, info: recovered.info });
          }
          return { ok: true, info: recovered.info, source: "child_artifact", backfilled: shouldBackfill };
        }
      }
    }
  }

  if (options.allowLegacyScan === false) {
    return { ok: false, reason: "missing_path", detail: projectPath };
  }

  const worktreeRoot = buildManagedWorktreeRoot(projectPath);
  if (!fs.existsSync(worktreeRoot)) {
    return { ok: false, reason: "no_candidate", detail: worktreeRoot };
  }

  const taskShortId = getTaskShortId(taskId);
  const candidates: Array<{ dirName: string; suffix: number; info: WorktreeInfo }> = [];

  try {
    for (const entry of fs.readdirSync(worktreeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const parsed = parseManagedWorktreeDirName(entry.name);
      if (!parsed || parsed.shortId !== taskShortId) continue;
      const expectedBranchName = `climpire/${entry.name}`;
      const recovered = resolveCandidateInfo(projectPath, entry.name, expectedBranchName);
      if (!recovered.ok) continue;
      candidates.push({
        dirName: entry.name,
        suffix: parsed.suffix,
        info: recovered.info,
      });
    }
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_git_worktree",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (candidates.length <= 0) {
    return { ok: false, reason: "no_candidate", detail: taskShortId };
  }

  candidates.sort((a, b) => b.suffix - a.suffix);
  const topSuffix = candidates[0]?.suffix ?? 0;
  const topCandidates = candidates.filter((candidate) => candidate.suffix === topSuffix);
  if (topCandidates.length !== 1) {
    return {
      ok: false,
      reason: "multiple_candidates",
      detail: topCandidates.map((candidate) => candidate.dirName).join(","),
    };
  }

  const selected = topCandidates[0]!;
  taskWorktrees.set(taskId, selected.info);
  const shouldBackfill = options.backfillRef !== false;
  if (shouldBackfill) {
    writeTaskWorktreeRef(db, {
      taskId,
      info: selected.info,
    });
  }
  return { ok: true, info: selected.info, source: "legacy_scan", backfilled: shouldBackfill };
}
