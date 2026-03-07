export type StartupReviewRecoveryRow = {
  id: string;
  title: string;
  source_task_id: string | null;
  parent_status: string | null;
};

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function shouldReplayReviewOnStartup(row: {
  source_task_id?: string | null;
  parent_status?: string | null;
}): boolean {
  const parentTaskId = normalizeText(row.source_task_id);
  if (!parentTaskId) return true;

  const parentStatus = normalizeText(row.parent_status).toLowerCase();
  if (!parentStatus) return true;
  return parentStatus === "done" || parentStatus === "cancelled";
}

export function filterStartupReviewRecoveryRows(rows: StartupReviewRecoveryRow[]): StartupReviewRecoveryRow[] {
  return rows.filter((row) => shouldReplayReviewOnStartup(row));
}
