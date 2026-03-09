import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;

export type TaskExecutionEventCategory = "retry" | "hook" | "watchdog";
export type TaskExecutionEventStatus = "info" | "success" | "warning" | "failure";
export type TaskExecutionHookSource = "global" | "project";

export type TaskExecutionEventInput = {
  taskId: string;
  category: TaskExecutionEventCategory;
  action: string;
  status: TaskExecutionEventStatus;
  message: string;
  details?: Record<string, unknown> | null;
  attemptCount?: number | null;
  hookSource?: TaskExecutionHookSource | null;
  durationMs?: number | null;
  createdAt?: number;
};

export type TaskExecutionEvent = {
  id: string;
  task_id: string;
  category: TaskExecutionEventCategory;
  action: string;
  status: TaskExecutionEventStatus;
  message: string;
  details: Record<string, unknown> | null;
  attempt_count: number | null;
  hook_source: TaskExecutionHookSource | null;
  duration_ms: number | null;
  created_at: number;
};

export type TaskExecutionSummary = {
  retry_count: number;
  last_retry_reason: string | null;
  pending_retry: boolean;
  hook_failures: number;
  project_hook_override_used: boolean;
  last_event_at: number | null;
};

function safeJsonStringify(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function safeJsonParseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeReason(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function recordTaskExecutionEvent(db: DbLike, input: TaskExecutionEventInput): void {
  try {
    db.prepare(
      `
        INSERT INTO task_execution_events (
          id, task_id, category, action, status, message,
          details_json, attempt_count, hook_source, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      randomUUID(),
      input.taskId,
      input.category,
      input.action,
      input.status,
      input.message,
      safeJsonStringify(input.details),
      input.attemptCount ?? null,
      input.hookSource ?? null,
      input.durationMs ?? null,
      input.createdAt ?? Date.now(),
    );
  } catch {
    // Legacy test harnesses may not define this table yet.
  }
}

export function listTaskExecutionEventsForTask(db: DbLike, taskId: string, limit = 50): TaskExecutionEvent[] {
  try {
    const rows = db
      .prepare(
        `
          SELECT
            id,
            task_id,
            category,
            action,
            status,
            message,
            details_json,
            attempt_count,
            hook_source,
            duration_ms,
            created_at
          FROM task_execution_events
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(taskId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      task_id: String(row.task_id ?? taskId),
      category: String(row.category ?? "watchdog") as TaskExecutionEventCategory,
      action: String(row.action ?? ""),
      status: String(row.status ?? "info") as TaskExecutionEventStatus,
      message: String(row.message ?? ""),
      details: safeJsonParseObject(row.details_json),
      attempt_count: row.attempt_count == null ? null : Number(row.attempt_count),
      hook_source:
        row.hook_source === "global" || row.hook_source === "project"
          ? (row.hook_source as TaskExecutionHookSource)
          : null,
      duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
      created_at: Number(row.created_at ?? 0) || 0,
    }));
  } catch {
    return [];
  }
}

export function summarizeTaskExecutionEvents(db: DbLike, taskId: string): TaskExecutionSummary {
  let retryCount = 0;
  let hookFailures = 0;
  let projectHookOverrideUsed = false;
  let lastEventAt: number | null = null;
  let lastRetryReason: string | null = null;
  let pendingRetry = false;

  try {
    const counts = db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN category = 'retry' THEN 1 ELSE 0 END) AS retry_count,
            SUM(CASE WHEN category = 'hook' AND status = 'failure' THEN 1 ELSE 0 END) AS hook_failures,
            MAX(CASE WHEN hook_source = 'project' THEN 1 ELSE 0 END) AS project_hook_override_used,
            MAX(created_at) AS last_event_at
          FROM task_execution_events
          WHERE task_id = ?
        `,
      )
      .get(taskId) as
      | {
          retry_count?: number | null;
          hook_failures?: number | null;
          project_hook_override_used?: number | null;
          last_event_at?: number | null;
        }
      | undefined;

    retryCount = Number(counts?.retry_count ?? 0) || 0;
    hookFailures = Number(counts?.hook_failures ?? 0) || 0;
    projectHookOverrideUsed = Number(counts?.project_hook_override_used ?? 0) > 0;
    lastEventAt = counts?.last_event_at == null ? null : Number(counts.last_event_at);
  } catch {
    // ignore missing table in legacy harnesses
  }

  try {
    const row = db
      .prepare(
        `
          SELECT details_json
          FROM task_execution_events
          WHERE task_id = ? AND category = 'retry'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(taskId) as { details_json?: unknown } | undefined;
    const details = safeJsonParseObject(row?.details_json);
    lastRetryReason = normalizeReason(details?.reason);
  } catch {
    // ignore
  }

  try {
    const retryRow = db.prepare("SELECT 1 FROM task_retry_queue WHERE task_id = ? LIMIT 1").get(taskId) as
      | { 1?: number }
      | undefined;
    pendingRetry = Boolean(retryRow);
  } catch {
    pendingRetry = false;
  }

  return {
    retry_count: retryCount,
    last_retry_reason: lastRetryReason,
    pending_retry: pendingRetry,
    hook_failures: hookFailures,
    project_hook_override_used: projectHookOverrideUsed,
    last_event_at: lastEventAt,
  };
}
