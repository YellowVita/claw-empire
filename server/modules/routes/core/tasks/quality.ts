import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;

export type TaskQualityKind = "acceptance" | "validation";
export type TaskQualityStatus = "pending" | "passed" | "failed" | "waived";
export type TaskQualitySource = "manual" | "workflow_meta" | "workflow_pack" | "system";

export type TaskQualitySummary = {
  required_total: number;
  passed: number;
  failed: number;
  pending: number;
  blocked_review: boolean;
};

export function computeTaskQualitySummary(items: Array<Record<string, unknown>>): TaskQualitySummary {
  let requiredTotal = 0;
  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const item of items) {
    const required = Number(item.required ?? 1) !== 0;
    if (!required) continue;
    requiredTotal += 1;
    const status = String(item.status ?? "pending");
    if (status === "passed" || status === "waived") passed += 1;
    else if (status === "failed") failed += 1;
    else pending += 1;
  }

  return {
    required_total: requiredTotal,
    passed,
    failed,
    pending,
    blocked_review: requiredTotal > 0 && (failed > 0 || pending > 0),
  };
}

export function loadTaskQualityItems(db: DbLike, taskId: string): Array<Record<string, unknown>> {
  try {
    return db
      .prepare("SELECT * FROM task_quality_items WHERE task_id = ? ORDER BY sort_order ASC, created_at ASC")
      .all(taskId) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function normalizeSeedList(raw: unknown, kind: TaskQualityKind, now: number): Array<{
  id: string;
  kind: TaskQualityKind;
  label: string;
  details: string | null;
  required: number;
  status: TaskQualityStatus;
  evidence_markdown: string | null;
  source: TaskQualitySource;
  sort_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      const label = typeof row.label === "string" ? row.label.trim() : "";
      if (!label) return null;
      const rawStatus = typeof row.status === "string" ? row.status.trim() : "pending";
      const status: TaskQualityStatus =
        rawStatus === "passed" || rawStatus === "failed" || rawStatus === "waived" ? rawStatus : "pending";
      const done = status === "passed" || status === "waived";
      return {
        id: randomUUID(),
        kind,
        label,
        details: typeof row.details === "string" && row.details.trim() ? row.details.trim() : null,
        required: row.required === false || row.required === 0 ? 0 : 1,
        status,
        evidence_markdown:
          typeof row.evidence_markdown === "string" && row.evidence_markdown.trim() ? row.evidence_markdown.trim() : null,
        source: "workflow_meta" as TaskQualitySource,
        sort_order: index,
        created_at: now,
        updated_at: now,
        completed_at: done ? now : null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export function seedTaskQualityItemsFromWorkflowMeta(
  db: DbLike,
  taskId: string,
  workflowMetaJson: string | null | undefined,
  now: number,
): void {
  if (!workflowMetaJson) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(workflowMetaJson);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

  const meta = parsed as Record<string, unknown>;
  const rows = [
    ...normalizeSeedList(meta.acceptance_items, "acceptance", now),
    ...normalizeSeedList(meta.validation_items, "validation", now).map((item, index) => ({
      ...item,
      sort_order: index + 1000,
    })),
  ];
  if (rows.length <= 0) return;

  let existingCount = 0;
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS cnt FROM task_quality_items WHERE task_id = ?")
      .get(taskId) as { cnt?: number } | undefined;
    existingCount = Number(row?.cnt ?? 0);
  } catch {
    return;
  }
  if (existingCount > 0) return;

  const insert = db.prepare(
    `
      INSERT INTO task_quality_items (
        id, task_id, kind, label, details, required, status, evidence_markdown, source,
        sort_order, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  try {
    for (const row of rows) {
      insert.run(
        row.id,
        taskId,
        row.kind,
        row.label,
        row.details,
        row.required,
        row.status,
        row.evidence_markdown,
        row.source,
        row.sort_order,
        row.created_at,
        row.updated_at,
        row.completed_at,
      );
    }
  } catch {
    // Legacy test harnesses may not define this table yet.
  }
}
