import type { DatabaseSync } from "node:sqlite";

export function listDuplicateReviewMeetingIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY task_id, round, status
          ORDER BY started_at DESC, created_at DESC, id DESC
        ) AS rn
      FROM meeting_minutes
      WHERE meeting_type = 'review'
        AND status IN ('in_progress', 'failed')
    )
    SELECT id
    FROM ranked
    WHERE rn > 1
  `,
    )
    .all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function deleteReviewMeetingCascade(db: DatabaseSync, meetingId: string): void {
  db.prepare("DELETE FROM meeting_minute_entries WHERE meeting_id = ?").run(meetingId);
  db.prepare("DELETE FROM meeting_minutes WHERE id = ?").run(meetingId);
}
