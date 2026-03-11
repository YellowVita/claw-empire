import type { DatabaseSync } from "node:sqlite";
import type { TaskRunSheetPrFeedbackGate, TaskRunSheetSnapshot, TaskRunSheetStage } from "./task-run-sheets.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

export type DevelopmentHandoffState =
  | "queued"
  | "in_progress"
  | "review_ready"
  | "human_review"
  | "merging"
  | "done"
  | "rework";

export type DevelopmentHandoffGateStatus = "passed" | "blocked" | "skipped" | null;

export type DevelopmentHandoffMetadata = {
  state: DevelopmentHandoffState;
  updated_at: number;
  status_snapshot: string | null;
  pending_retry: boolean;
  pr_gate_status: DevelopmentHandoffGateStatus;
  pr_url: string | null;
  summary: string | null;
};

type TaskMetaRow = {
  workflow_pack_key: string | null;
  workflow_meta_json: string | null;
  status: string | null;
};

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function parseWorkflowMetaObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

export function buildDevelopmentHandoffSummary(input: {
  state: DevelopmentHandoffState;
  pendingRetry: boolean;
  prGateStatus: DevelopmentHandoffGateStatus;
}): string {
  if (input.pendingRetry) return "Retry scheduled after failed run";
  if (input.prGateStatus === "blocked") return "Blocked by PR feedback gate";
  switch (input.state) {
    case "queued":
      return "Queued for execution";
    case "in_progress":
      return "Implementation in progress";
    case "review_ready":
      return "Ready for human review";
    case "human_review":
      return "Waiting for human review";
    case "merging":
      return "Merge in progress";
    case "done":
      return "Completed and handed off";
    case "rework":
      return "Rework required before review";
    default:
      return "Development handoff updated";
  }
}

export function normalizeDevelopmentHandoffMetadata(raw: unknown): DevelopmentHandoffMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const state = normalizeText(source.state);
  if (
    state !== "queued" &&
    state !== "in_progress" &&
    state !== "review_ready" &&
    state !== "human_review" &&
    state !== "merging" &&
    state !== "done" &&
    state !== "rework"
  ) {
    return null;
  }
  const updatedAtValue =
    typeof source.updated_at === "number" ? source.updated_at : Number(source.updated_at ?? 0);
  const prGateStatus = normalizeText(source.pr_gate_status);
  return {
    state,
    updated_at: Number.isFinite(updatedAtValue) && updatedAtValue > 0 ? Math.trunc(updatedAtValue) : 0,
    status_snapshot: normalizeText(source.status_snapshot),
    pending_retry: normalizeBoolean(source.pending_retry),
    pr_gate_status:
      prGateStatus === "passed" || prGateStatus === "blocked" || prGateStatus === "skipped" ? prGateStatus : null,
    pr_url: normalizeText(source.pr_url),
    summary: normalizeText(source.summary),
  };
}

export function readDevelopmentHandoffFromTaskLike(task: {
  workflow_pack_key?: unknown;
  workflow_meta_json?: unknown;
}): DevelopmentHandoffMetadata | null {
  if (normalizeText(task.workflow_pack_key) !== "development") return null;
  const workflowMeta = parseWorkflowMetaObject(task.workflow_meta_json);
  return normalizeDevelopmentHandoffMetadata(workflowMeta.development_handoff);
}

export function decorateTaskWithDevelopmentHandoff<T extends { workflow_pack_key?: unknown; workflow_meta_json?: unknown }>(
  task: T,
): T & { development_handoff: DevelopmentHandoffMetadata | null } {
  return {
    ...task,
    development_handoff: readDevelopmentHandoffFromTaskLike(task),
  };
}

function readTaskMetaRow(db: DbLike, taskId: string): TaskMetaRow | null {
  try {
    const row = db
      .prepare("SELECT workflow_pack_key, workflow_meta_json, status FROM tasks WHERE id = ?")
      .get(taskId) as TaskMetaRow | undefined;
    return row ?? null;
  } catch {
    try {
      const row = db
        .prepare("SELECT workflow_pack_key, NULL AS workflow_meta_json, status FROM tasks WHERE id = ?")
        .get(taskId) as TaskMetaRow | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }
}

export function upsertDevelopmentHandoffMetadata(db: DbLike, input: {
  taskId: string;
  state: DevelopmentHandoffState;
  updatedAt?: number;
  pendingRetry?: boolean;
  prGateStatus?: DevelopmentHandoffGateStatus;
  prUrl?: string | null;
  summary?: string | null;
}): void {
  const task = readTaskMetaRow(db, input.taskId);
  if (!task || normalizeText(task.workflow_pack_key) !== "development") return;

  const workflowMeta = parseWorkflowMetaObject(task.workflow_meta_json);
  const existing = normalizeDevelopmentHandoffMetadata(workflowMeta.development_handoff);
  const updatedAt = input.updatedAt ?? Date.now();
  const pendingRetry = input.pendingRetry ?? existing?.pending_retry ?? false;
  const prGateStatus = input.prGateStatus ?? existing?.pr_gate_status ?? null;
  const prUrl =
    input.prUrl !== undefined ? input.prUrl : existing?.pr_url ?? null;
  const summary =
    input.summary !== undefined
      ? input.summary
      : buildDevelopmentHandoffSummary({
          state: input.state,
          pendingRetry,
          prGateStatus,
        });

  const next: DevelopmentHandoffMetadata = {
    state: input.state,
    updated_at: updatedAt,
    status_snapshot: normalizeText(task.status),
    pending_retry: pendingRetry,
    pr_gate_status: prGateStatus,
    pr_url: prUrl,
    summary,
  };

  try {
    db.prepare(
      `
        UPDATE tasks
        SET workflow_meta_json = json_set(
              CASE
                WHEN json_valid(workflow_meta_json) THEN workflow_meta_json
                ELSE '{}'
              END,
              '$.development_handoff',
              json(?)
            ),
            updated_at = ?
        WHERE id = ?
          AND workflow_pack_key = 'development'
      `,
    ).run(JSON.stringify(next), updatedAt, input.taskId);
  } catch {
    // Legacy harnesses may not define workflow_meta_json yet.
  }
}

export function clearDevelopmentHandoffMetadata(db: DbLike, input: {
  taskId: string;
  updatedAt?: number;
}): void {
  const updatedAt = input.updatedAt ?? Date.now();
  try {
    db.prepare(
      `
        UPDATE tasks
        SET workflow_meta_json = CASE
              WHEN json_valid(workflow_meta_json) THEN json_remove(workflow_meta_json, '$.development_handoff')
              ELSE workflow_meta_json
            END,
            updated_at = ?
        WHERE id = ?
      `,
    ).run(updatedAt, input.taskId);
  } catch {
    // Legacy harnesses may not define workflow_meta_json yet.
  }
}

export function syncDevelopmentHandoffFromRunSheet(db: DbLike, input: {
  taskId: string;
  stage: TaskRunSheetStage;
  snapshot: TaskRunSheetSnapshot;
  updatedAt?: number;
}): void {
  const gate: TaskRunSheetPrFeedbackGate | null = input.snapshot.review_checklist.pr_feedback_gate ?? null;
  upsertDevelopmentHandoffMetadata(db, {
    taskId: input.taskId,
    state: input.stage,
    updatedAt: input.updatedAt,
    pendingRetry: input.snapshot.review_checklist.pending_retry || input.snapshot.validation.pending_retry,
    prGateStatus: gate?.status ?? null,
    prUrl: gate?.pr_url ?? null,
    summary: buildDevelopmentHandoffSummary({
      state: input.stage,
      pendingRetry: input.snapshot.review_checklist.pending_retry || input.snapshot.validation.pending_retry,
      prGateStatus: gate?.status ?? null,
    }),
  });
}
