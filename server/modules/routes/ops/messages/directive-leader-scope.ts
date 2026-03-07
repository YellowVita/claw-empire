import type { DatabaseSync } from "node:sqlite";
import type { WorkflowPackKey } from "../../../workflow/packs/definitions.ts";
import {
  resolveEffectiveWorkflowPackKey,
  resolveTaskScopedAgentIds,
} from "../../../workflow/packs/agent-scope.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

export { readActiveOfficePackKey } from "../../../workflow/packs/agent-scope.ts";

export function resolveDirectiveWorkflowPackKey(db: DbLike, projectId: string | null): WorkflowPackKey | null {
  return resolveEffectiveWorkflowPackKey({
    db,
    projectId,
  });
}

export function resolveDirectiveLeaderCandidateScope(
  db: DbLike,
  projectId: string | null,
  departmentId: string | null = "planning",
): string[] | null {
  return resolveTaskScopedAgentIds({
    db,
    projectId,
    departmentId: departmentId ?? "planning",
  });
}
