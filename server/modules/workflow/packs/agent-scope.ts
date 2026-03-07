import type { DatabaseSync } from "node:sqlite";
import { resolveConstrainedAgentScopeForTask } from "../../routes/core/tasks/execution-run-auto-assign.ts";
import { DEFAULT_WORKFLOW_PACK_KEY, isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";
import { resolveTaskPackKeyById, resolveWorkflowPackKeyForTask } from "./task-pack-resolver.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

type TeamLeaderLookup<TAgent> = (departmentId: string | null, candidateAgentIds?: string[] | null) => TAgent | null;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parsePackSetting(value: unknown): WorkflowPackKey | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  let candidate = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") candidate = parsed.trim();
  } catch {
    // keep raw text
  }

  return isWorkflowPackKey(candidate) ? candidate : null;
}

export function readActiveOfficePackKey(db: DbLike): WorkflowPackKey | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'officeWorkflowPack' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  if (!row) return null;
  return parsePackSetting(row.value);
}

export function resolveEffectiveWorkflowPackKey(params: {
  db: DbLike;
  projectId?: string | null;
  sourceTaskId?: string | null;
  explicitPackKey?: unknown;
  fallbackPackKey?: WorkflowPackKey;
}): WorkflowPackKey {
  const { db, projectId, sourceTaskId, explicitPackKey, fallbackPackKey } = params;
  const taskPackKey = resolveTaskPackKeyById(db, sourceTaskId);
  const activePackKey = readActiveOfficePackKey(db);
  return resolveWorkflowPackKeyForTask({
    db,
    explicitPackKey,
    sourceTaskPackKey: taskPackKey,
    sourceTaskId: sourceTaskId ?? null,
    projectId: normalizeText(projectId) || null,
    fallbackPackKey: fallbackPackKey ?? activePackKey ?? DEFAULT_WORKFLOW_PACK_KEY,
  });
}

export function resolvePackScopedAgentIds(params: {
  db: DbLike;
  departmentId?: string | null;
  projectId?: string | null;
  sourceTaskId?: string | null;
  explicitPackKey?: unknown;
  fallbackPackKey?: WorkflowPackKey;
}): string[] | null {
  const { db, departmentId, projectId, sourceTaskId, explicitPackKey, fallbackPackKey } = params;
  const workflowPackKey = resolveEffectiveWorkflowPackKey({
    db,
    projectId,
    sourceTaskId,
    explicitPackKey,
    fallbackPackKey,
  });
  return resolveConstrainedAgentScopeForTask(db, {
    project_id: null,
    workflow_pack_key: workflowPackKey,
    department_id: normalizeText(departmentId) || null,
  });
}

export function resolveTaskScopedAgentIds(params: {
  db: DbLike;
  departmentId?: string | null;
  projectId?: string | null;
  sourceTaskId?: string | null;
  explicitPackKey?: unknown;
  fallbackPackKey?: WorkflowPackKey;
}): string[] | null {
  const { db, departmentId, projectId, sourceTaskId, explicitPackKey, fallbackPackKey } = params;
  const workflowPackKey = resolveEffectiveWorkflowPackKey({
    db,
    projectId,
    sourceTaskId,
    explicitPackKey,
    fallbackPackKey,
  });
  return resolveConstrainedAgentScopeForTask(db, {
    project_id: normalizeText(projectId) || null,
    workflow_pack_key: workflowPackKey,
    department_id: normalizeText(departmentId) || null,
  });
}

export function isAgentIdInScope(agentId: string | null | undefined, candidateAgentIds: string[] | null): boolean {
  const normalizedAgentId = normalizeText(agentId);
  if (!normalizedAgentId || !Array.isArray(candidateAgentIds)) return false;
  return candidateAgentIds.includes(normalizedAgentId);
}

export function resolveScopedTeamLeader<TAgent>(params: {
  db: DbLike;
  findTeamLeader: TeamLeaderLookup<TAgent>;
  departmentId: string | null;
  projectId?: string | null;
  sourceTaskId?: string | null;
  explicitPackKey?: unknown;
  fallbackPackKey?: WorkflowPackKey;
  scope: "pack" | "task";
  allowPackFallback?: boolean;
}): TAgent | null {
  const {
    db,
    findTeamLeader,
    departmentId,
    projectId,
    sourceTaskId,
    explicitPackKey,
    fallbackPackKey,
    scope,
    allowPackFallback,
  } = params;
  if (!normalizeText(departmentId)) return null;

  const scopedCandidateAgentIds =
    scope === "task"
      ? resolveTaskScopedAgentIds({
          db,
          departmentId,
          projectId,
          sourceTaskId,
          explicitPackKey,
          fallbackPackKey,
        })
      : resolvePackScopedAgentIds({
          db,
          departmentId,
          projectId,
          sourceTaskId,
          explicitPackKey,
          fallbackPackKey,
        });
  const scopedLeader = findTeamLeader(departmentId, scopedCandidateAgentIds);
  if (scopedLeader) return scopedLeader;
  if (scope !== "task" || !allowPackFallback) return null;

  const packScopedAgentIds = resolvePackScopedAgentIds({
    db,
    departmentId,
    projectId,
    sourceTaskId,
    explicitPackKey,
    fallbackPackKey,
  });
  return findTeamLeader(departmentId, packScopedAgentIds);
}
