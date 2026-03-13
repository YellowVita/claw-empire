import type { DatabaseSync } from "node:sqlite";

import {
  clearWorkingAgentIfTaskMatches,
  getAgentById,
  listWorkingAgentsWithTaskStatus,
} from "../../db/queries/agent-queries.ts";

export type WorkingAgentRecoveryReason = "startup" | "interval";

export interface OrphanWorkingAgentRecoveryDeps {
  db: DatabaseSync;
  broadcast: (type: string, payload: unknown) => void;
}

export function recoverOrphanWorkingAgents(
  { db, broadcast }: OrphanWorkingAgentRecoveryDeps,
  reason: WorkingAgentRecoveryReason,
): void {
  for (const row of listWorkingAgentsWithTaskStatus(db)) {
    const normalizedTaskStatus = String(row.task_status ?? "")
      .trim()
      .toLowerCase();
    if (row.task_id && normalizedTaskStatus === "in_progress") continue;

    const staleReason = row.task_id ? `task_status_${normalizedTaskStatus || "unknown"}` : "task_missing";
    if (clearWorkingAgentIfTaskMatches(db, row.agent_id, row.current_task_id) === 0) continue;
    broadcast("agent_status", getAgentById(db, row.agent_id));
    console.warn(
      `[Claw-Empire] Recovery (${reason}): cleared stale working agent ${row.agent_id} (${row.agent_name || "unknown"}) -> ${row.current_task_id} (${staleReason})`,
    );
  }
}
