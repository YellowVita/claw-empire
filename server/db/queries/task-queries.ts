import type { DatabaseSync } from "node:sqlite";

export type InProgressTaskRow = {
  id: string;
  title: string;
  assigned_agent_id: string | null;
  created_at: number | null;
  started_at: number | null;
  updated_at: number | null;
};

export type RetryTaskRow = {
  id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
};

export function setTaskStatus(db: DatabaseSync, taskId: string, status: string, updatedAt: number): void {
  db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, taskId);
}

export function setTaskInboxIfInProgress(db: DatabaseSync, taskId: string, updatedAt: number): number {
  const result = db
    .prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ? AND status = 'in_progress'")
    .run(updatedAt, taskId) as { changes?: number };
  return result.changes ?? 0;
}

export function getTaskById(db: DatabaseSync, taskId: string) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
}

export function getTaskStatusById(db: DatabaseSync, taskId: string): string | null {
  const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
  return row?.status ?? null;
}

export function listInProgressTasks(db: DatabaseSync): InProgressTaskRow[] {
  return db
    .prepare(
      `
    SELECT id, title, assigned_agent_id, created_at, started_at, updated_at
    FROM tasks
    WHERE status = 'in_progress'
    ORDER BY updated_at ASC
  `,
    )
    .all() as InProgressTaskRow[];
}

export function getRecentTaskLog(
  db: DatabaseSync,
  taskId: string,
  threshold: number,
): { created_at: number } | undefined {
  return db
    .prepare(
      `
      SELECT created_at FROM task_logs
      WHERE task_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT 1
    `,
    )
    .get(taskId, threshold) as { created_at: number } | undefined;
}

export function getLatestRunLog(
  db: DatabaseSync,
  taskId: string,
): {
  message: string;
} | undefined {
  return db
    .prepare(
      `
      SELECT message
      FROM task_logs
      WHERE task_id = ?
        AND kind = 'system'
        AND (message LIKE 'RUN %' OR message LIKE 'Agent spawn failed:%')
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(taskId) as { message: string } | undefined;
}

export function getRetryTaskById(db: DatabaseSync, taskId: string): RetryTaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as RetryTaskRow | undefined;
}

export function listStartupReviewTasks(db: DatabaseSync): Array<{
  id: string;
  title: string;
  source_task_id: string | null;
  parent_status: string | null;
}> {
  return db
    .prepare(
      `
    SELECT t.id, t.title, t.source_task_id, p.status AS parent_status
    FROM tasks t
    LEFT JOIN tasks p ON p.id = t.source_task_id
    WHERE t.status = 'review'
    ORDER BY t.updated_at ASC
  `,
    )
    .all() as Array<{ id: string; title: string; source_task_id: string | null; parent_status: string | null }>;
}

export function listPendingDelegationParentTaskIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT t.id
    FROM tasks t
    LEFT JOIN subtasks s ON s.task_id = t.id
    WHERE t.status IN ('planned', 'collaborating', 'in_progress', 'review')
      AND (
        (
          s.target_department_id IS NOT NULL
          AND s.status != 'done'
          AND (s.delegated_task_id IS NULL OR s.delegated_task_id = '')
        )
        OR (
          COALESCE(t.orchestration_version, 1) >= 2
          AND (
            t.orchestration_stage IN ('owner_integrate', 'finalize', 'foreign_collab')
            OR (
              t.orchestration_stage = 'review'
              AND EXISTS (
                SELECT 1
                FROM subtasks s2
                WHERE s2.task_id = t.id
                  AND s2.status NOT IN ('done', 'cancelled')
                  AND (
                    s2.target_department_id IS NOT NULL
                    OR s2.orchestration_phase IN ('foreign_collab', 'owner_integrate', 'finalize')
                  )
              )
            )
          )
        )
      )
    ORDER BY t.updated_at ASC
    LIMIT 80
  `,
    )
    .all() as Array<{ id: string }>;
  return rows.map((row) => row.id).filter(Boolean);
}
