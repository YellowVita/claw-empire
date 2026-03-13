import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;

export type IntegrationRepairMode = "merge_conflict_resolution" | "integration_repair";

export type IntegrationRepairContext = {
  mode: IntegrationRepairMode;
  child_task_id: string | null;
  child_title: string | null;
  child_branch_name: string | null;
  parent_head_sha: string | null;
  child_head_sha: string | null;
  conflicts: string[];
  last_error: string | null;
  updated_at: number;
};

type TaskMetaRow = {
  workflow_meta_json: string | null;
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
    const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get(taskId) as TaskMetaRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function upsertIntegrationRepairContext(
  db: DbLike,
  taskId: string,
  context: IntegrationRepairContext,
  updatedAt: number,
): void {
  try {
    db.prepare(
      `
        UPDATE tasks
        SET workflow_meta_json = json_set(
              CASE
                WHEN json_valid(workflow_meta_json) THEN workflow_meta_json
                ELSE '{}'
              END,
              '$.integration_repair_context',
              json(?)
            ),
            updated_at = ?
        WHERE id = ?
      `,
    ).run(JSON.stringify(context), updatedAt, taskId);
  } catch {
    // ignore legacy harnesses without workflow_meta_json
  }
}

export function normalizeIntegrationRepairContext(raw: unknown): IntegrationRepairContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const mode = normalizeText(source.mode);
  if (mode !== "merge_conflict_resolution" && mode !== "integration_repair") return null;
  const updatedAt =
    typeof source.updated_at === "number" ? source.updated_at : Number(source.updated_at ?? 0);
  const conflicts = Array.isArray(source.conflicts)
    ? source.conflicts
        .map((entry) => normalizeText(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];
  return {
    mode,
    child_task_id: normalizeText(source.child_task_id),
    child_title: normalizeText(source.child_title),
    child_branch_name: normalizeText(source.child_branch_name),
    parent_head_sha: normalizeText(source.parent_head_sha),
    child_head_sha: normalizeText(source.child_head_sha),
    conflicts,
    last_error: normalizeText(source.last_error),
    updated_at: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : 0,
  };
}

export function readIntegrationRepairContext(db: DbLike, taskId: string): IntegrationRepairContext | null {
  const row = readTaskMetaRow(db, taskId);
  if (!row) return null;
  const workflowMeta = parseWorkflowMetaObject(row.workflow_meta_json);
  return normalizeIntegrationRepairContext(workflowMeta.integration_repair_context);
}

export function writeIntegrationRepairContext(
  db: DbLike,
  input: {
    taskId: string;
    mode: IntegrationRepairMode;
    childTaskId?: string | null;
    childTitle?: string | null;
    childBranchName?: string | null;
    parentHeadSha?: string | null;
    childHeadSha?: string | null;
    conflicts?: string[];
    lastError?: string | null;
    updatedAt?: number;
  },
): void {
  const updatedAt = input.updatedAt ?? Date.now();
  upsertIntegrationRepairContext(
    db,
    input.taskId,
    {
      mode: input.mode,
      child_task_id: input.childTaskId ?? null,
      child_title: input.childTitle ?? null,
      child_branch_name: input.childBranchName ?? null,
      parent_head_sha: input.parentHeadSha ?? null,
      child_head_sha: input.childHeadSha ?? null,
      conflicts: Array.isArray(input.conflicts) ? input.conflicts.filter(Boolean) : [],
      last_error: input.lastError ?? null,
      updated_at: updatedAt,
    },
    updatedAt,
  );
}

export function clearIntegrationRepairContext(db: DbLike, taskId: string, updatedAt = Date.now()): void {
  try {
    db.prepare(
      `
        UPDATE tasks
        SET workflow_meta_json = CASE
              WHEN json_valid(workflow_meta_json) THEN json_remove(workflow_meta_json, '$.integration_repair_context')
              ELSE workflow_meta_json
            END,
            updated_at = ?
        WHERE id = ?
      `,
    ).run(updatedAt, taskId);
  } catch {
    // ignore legacy harnesses without workflow_meta_json
  }
}

export function buildIntegrationRepairPromptBlock(context: IntegrationRepairContext | null): string {
  if (!context) return "";
  const lines = [
    "[Integration Repair Context]",
    `Mode: ${context.mode}`,
    context.child_title ? `Child task: ${context.child_title}` : "",
    context.child_branch_name ? `Child branch: ${context.child_branch_name}` : "",
    context.parent_head_sha ? `Parent HEAD before conflict: ${context.parent_head_sha}` : "",
    context.child_head_sha ? `Child HEAD: ${context.child_head_sha}` : "",
    context.conflicts.length > 0 ? `Conflicting files: ${context.conflicts.join(", ")}` : "",
    context.last_error ? `Last integration error: ${context.last_error}` : "",
    "You are reopening the parent owner_integrate task to resolve this branch-ingestion problem.",
    "Work in the existing parent worktree state, preserve completed child deliverables, resolve conflicts, run the required checks, and prepare the branch for final review.",
  ].filter(Boolean);
  return lines.join("\n");
}
