import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;

export type CollabBranchIngestionState =
  | "ready_for_parent_ingest"
  | "conflict_pending_resolution"
  | "ingested"
  | "orphaned";

export type CollabBranchArtifactMetadata = {
  branch_name: string;
  head_sha: string;
  auto_commit_sha: string | null;
  ingestion_state: CollabBranchIngestionState;
  updated_at: number;
  ingested_by_task_id: string | null;
  ingested_commit_sha: string | null;
  ingested_at: number | null;
  orphaned_reason: string | null;
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

export function normalizeCollabBranchArtifactMetadata(raw: unknown): CollabBranchArtifactMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const branchName = normalizeText(source.branch_name);
  const headSha = normalizeText(source.head_sha);
  const ingestionState = normalizeText(source.ingestion_state);
  const updatedAt =
    typeof source.updated_at === "number" ? source.updated_at : Number(source.updated_at ?? 0);
  if (!branchName || !headSha) return null;
  if (
    ingestionState !== "ready_for_parent_ingest" &&
    ingestionState !== "conflict_pending_resolution" &&
    ingestionState !== "ingested" &&
    ingestionState !== "orphaned"
  ) {
    return null;
  }
  return {
    branch_name: branchName,
    head_sha: headSha,
    auto_commit_sha: normalizeText(source.auto_commit_sha),
    ingestion_state: ingestionState,
    updated_at: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : 0,
    ingested_by_task_id: normalizeText(source.ingested_by_task_id),
    ingested_commit_sha: normalizeText(source.ingested_commit_sha),
    ingested_at:
      typeof source.ingested_at === "number"
        ? Math.trunc(source.ingested_at)
        : Number(source.ingested_at ?? 0) > 0
          ? Math.trunc(Number(source.ingested_at))
          : null,
    orphaned_reason: normalizeText(source.orphaned_reason),
  };
}

function readTaskMetaRow(db: DbLike, taskId: string): TaskMetaRow | null {
  try {
    const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get(taskId) as TaskMetaRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function upsertCollabBranchArtifactMetadata(
  db: DbLike,
  taskId: string,
  metadata: CollabBranchArtifactMetadata,
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
              '$.collab_branch_artifact',
              json(?)
            ),
            updated_at = ?
        WHERE id = ?
      `,
    ).run(JSON.stringify(metadata), updatedAt, taskId);
  } catch {
    // Legacy harnesses may not define workflow_meta_json yet.
  }
}

export function readCollabBranchArtifactMetadata(db: DbLike, taskId: string): CollabBranchArtifactMetadata | null {
  const row = readTaskMetaRow(db, taskId);
  if (!row) return null;
  const workflowMeta = parseWorkflowMetaObject(row.workflow_meta_json);
  return normalizeCollabBranchArtifactMetadata(workflowMeta.collab_branch_artifact);
}

export function markCollabBranchArtifactReady(
  db: DbLike,
  input: {
    taskId: string;
    branchName: string;
    headSha: string;
    autoCommitSha?: string | null;
    updatedAt?: number;
  },
): void {
  const existing = readCollabBranchArtifactMetadata(db, input.taskId);
  const updatedAt = input.updatedAt ?? Date.now();
  upsertCollabBranchArtifactMetadata(
    db,
    input.taskId,
    {
      branch_name: input.branchName,
      head_sha: input.headSha,
      auto_commit_sha: input.autoCommitSha ?? null,
      ingestion_state: "ready_for_parent_ingest",
      updated_at: updatedAt,
      ingested_by_task_id: existing?.ingested_by_task_id ?? null,
      ingested_commit_sha: existing?.ingested_commit_sha ?? null,
      ingested_at: existing?.ingested_at ?? null,
      orphaned_reason: null,
    },
    updatedAt,
  );
}

export function markCollabBranchArtifactIngested(
  db: DbLike,
  input: {
    taskId: string;
    parentTaskId: string;
    ingestedCommitSha: string;
    updatedAt?: number;
  },
): void {
  const existing = readCollabBranchArtifactMetadata(db, input.taskId);
  if (!existing) return;
  const updatedAt = input.updatedAt ?? Date.now();
  upsertCollabBranchArtifactMetadata(
    db,
    input.taskId,
    {
      ...existing,
      ingestion_state: "ingested",
      updated_at: updatedAt,
      ingested_by_task_id: input.parentTaskId,
      ingested_commit_sha: input.ingestedCommitSha,
      ingested_at: updatedAt,
      orphaned_reason: null,
    },
    updatedAt,
  );
}

export function markCollabBranchArtifactConflictPending(
  db: DbLike,
  input: {
    taskId: string;
    updatedAt?: number;
  },
): void {
  const existing = readCollabBranchArtifactMetadata(db, input.taskId);
  if (!existing || existing.ingestion_state === "ingested") return;
  const updatedAt = input.updatedAt ?? Date.now();
  upsertCollabBranchArtifactMetadata(
    db,
    input.taskId,
    {
      ...existing,
      ingestion_state: "conflict_pending_resolution",
      updated_at: updatedAt,
      orphaned_reason: null,
    },
    updatedAt,
  );
}

export function markCollabBranchArtifactOrphaned(
  db: DbLike,
  input: {
    taskId: string;
    reason: string;
    updatedAt?: number;
  },
): void {
  const existing = readCollabBranchArtifactMetadata(db, input.taskId);
  if (!existing || existing.ingestion_state === "ingested") return;
  const updatedAt = input.updatedAt ?? Date.now();
  upsertCollabBranchArtifactMetadata(
    db,
    input.taskId,
    {
      ...existing,
      ingestion_state: "orphaned",
      updated_at: updatedAt,
      orphaned_reason: input.reason,
    },
    updatedAt,
  );
}

export function listPendingParentIngestionChildren(
  db: DbLike,
  parentTaskId: string,
): Array<{
  id: string;
  title: string;
  status: string;
  source_task_id: string | null;
  project_path: string | null;
  workflow_meta_json: string | null;
}> {
  try {
    const rows = db
      .prepare(
        `
          SELECT id, title, status, source_task_id, project_path, workflow_meta_json
          FROM tasks
          WHERE source_task_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(parentTaskId) as Array<{
      id: string;
      title: string;
      status: string;
      source_task_id: string | null;
      project_path: string | null;
      workflow_meta_json: string | null;
    }>;
    return rows.filter((row) => {
      const workflowMeta = parseWorkflowMetaObject(row.workflow_meta_json);
      const artifact = normalizeCollabBranchArtifactMetadata(workflowMeta.collab_branch_artifact);
      return (
        (artifact?.ingestion_state === "ready_for_parent_ingest" ||
          artifact?.ingestion_state === "conflict_pending_resolution") &&
        !artifact.ingested_at
      );
    });
  } catch {
    return [];
  }
}
