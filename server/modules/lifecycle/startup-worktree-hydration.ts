import type { DatabaseSync } from "node:sqlite";

import type { WorktreeInfo } from "../workflow/core/worktree/lifecycle.ts";
import { readTaskWorktreeRef, recoverTaskWorktreeInfo } from "../workflow/core/worktree/worktree-registry.ts";

export type StartupWorktreeHydrationSummary = {
  scannedCount: number;
  hydratedCount: number;
  skippedCleanedCount: number;
  failedCount: number;
};

export interface StartupWorktreeHydrationDeps {
  db: DatabaseSync;
  taskWorktrees: Map<string, WorktreeInfo>;
}

export function hydrateStartupWorktrees({
  db,
  taskWorktrees,
}: StartupWorktreeHydrationDeps): StartupWorktreeHydrationSummary {
  const rows = db
    .prepare(
      `
        SELECT id
        FROM tasks
        WHERE status IN ('pending', 'in_progress', 'review')
      `,
    )
    .all() as Array<{ id: string }>;

  const summary: StartupWorktreeHydrationSummary = {
    scannedCount: 0,
    hydratedCount: 0,
    skippedCleanedCount: 0,
    failedCount: 0,
  };

  for (const row of rows) {
    const worktreeRef = readTaskWorktreeRef(db as any, row.id);
    if (!worktreeRef) continue;
    if (worktreeRef.state !== "active") {
      summary.skippedCleanedCount += 1;
      continue;
    }
    summary.scannedCount += 1;
    const recovered = recoverTaskWorktreeInfo(db as any, row.id, taskWorktrees, {
      projectPath: worktreeRef.project_path,
      allowChildArtifactFallback: false,
      allowLegacyScan: false,
      backfillRef: false,
    });
    if (recovered.ok) {
      summary.hydratedCount += 1;
    } else {
      summary.failedCount += 1;
    }
  }

  return summary;
}
