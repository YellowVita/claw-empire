import type { DatabaseSync } from "node:sqlite";

import { listPendingDelegationParentTaskIds } from "../../db/queries/task-queries.ts";

export interface PendingSubtaskDelegationSweepDeps {
  db: DatabaseSync;
  processSubtaskDelegations: (taskId: string) => void;
}

export function sweepPendingSubtaskDelegations({
  db,
  processSubtaskDelegations,
}: PendingSubtaskDelegationSweepDeps): void {
  for (const taskId of listPendingDelegationParentTaskIds(db)) {
    if (!taskId) continue;
    processSubtaskDelegations(taskId);
  }
}
