import type { DatabaseSync } from "node:sqlite";

import { resolveConstrainedAgentScopeForTask } from "../core/tasks/execution-run-auto-assign.ts";
import { readActiveOfficeWorkflowPackKey } from "../../workflow/packs/department-scope.ts";
import { isWorkflowPackKey, type WorkflowPackKey } from "../../workflow/packs/definitions.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inferPackKeyFromAgentId(agentId: string | null | undefined): WorkflowPackKey | null {
  const normalized = normalizeText(agentId);
  if (!normalized) return null;
  const matched = normalized.match(/^([a-z0-9_]+)-seed-\d+$/i);
  if (!matched?.[1]) return null;
  const candidate = matched[1].toLowerCase();
  return isWorkflowPackKey(candidate) ? candidate : null;
}

export function resolveMentionDelegationScope(
  db: DbLike,
  originLeaderId: string | null | undefined,
  targetDeptId: string | null | undefined,
): { workflowPackKey: WorkflowPackKey; candidateAgentIds: string[] | null } {
  const workflowPackKey = inferPackKeyFromAgentId(originLeaderId) ?? readActiveOfficeWorkflowPackKey(db);
  const candidateAgentIds = resolveConstrainedAgentScopeForTask(db, {
    workflow_pack_key: workflowPackKey,
    department_id: normalizeText(targetDeptId) || null,
    project_id: null,
  });
  return { workflowPackKey, candidateAgentIds };
}
