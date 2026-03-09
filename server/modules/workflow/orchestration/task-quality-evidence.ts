import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;

export type TaskQualityRunType = "command" | "artifact_check" | "system";
export type TaskQualityRunStatus = "passed" | "failed" | "skipped";
export type TaskArtifactKind = "report_archive" | "video" | "file" | "document" | "other";
export type TaskArtifactSource = "auto" | "report_archive" | "video_gate" | "system";

export type TaskQualityRun = {
  id: string;
  task_id: string;
  quality_item_id: string | null;
  run_type: TaskQualityRunType;
  name: string;
  command: string | null;
  status: TaskQualityRunStatus;
  exit_code: number | null;
  summary: string | null;
  output_excerpt: string | null;
  metadata: Record<string, unknown> | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
};

export type TaskArtifact = {
  id: string;
  task_id: string;
  quality_item_id: string | null;
  kind: TaskArtifactKind;
  title: string;
  path: string | null;
  mime: string | null;
  size_bytes: number | null;
  source: TaskArtifactSource;
  metadata: Record<string, unknown> | null;
  created_at: number;
};

export type RecordTaskQualityRunInput = {
  taskId: string;
  qualityItemId?: string | null;
  runType: TaskQualityRunType;
  name: string;
  command?: string | null;
  status: TaskQualityRunStatus;
  exitCode?: number | null;
  summary?: string | null;
  outputExcerpt?: string | null;
  metadata?: Record<string, unknown> | null;
  startedAt?: number | null;
  completedAt?: number | null;
  createdAt?: number;
};

export type RecordTaskArtifactInput = {
  taskId: string;
  qualityItemId?: string | null;
  kind: TaskArtifactKind;
  title: string;
  path?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
  source: TaskArtifactSource;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
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

function normalizeNumber(value: unknown): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function findReportArchiveArtifactId(db: DbLike, taskId: string, archiveId: string): string | null {
  try {
    const rows = db
      .prepare("SELECT id, metadata_json FROM task_artifacts WHERE task_id = ? AND kind = 'report_archive'")
      .all(taskId) as Array<{ id?: unknown; metadata_json?: unknown }>;
    for (const row of rows) {
      const metadata = safeJsonParseObject(row.metadata_json);
      if (typeof metadata?.archive_id === "string" && metadata.archive_id === archiveId) {
        return String(row.id ?? "");
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function recordTaskQualityRun(db: DbLike, input: RecordTaskQualityRunInput): void {
  try {
    db.prepare(
      `
        INSERT INTO task_quality_runs (
          id, task_id, quality_item_id, run_type, name, command, status, exit_code,
          summary, output_excerpt, metadata_json, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      randomUUID(),
      input.taskId,
      input.qualityItemId ?? null,
      input.runType,
      input.name,
      input.command ?? null,
      input.status,
      input.exitCode ?? null,
      input.summary ?? null,
      input.outputExcerpt ?? null,
      safeJsonStringify(input.metadata),
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.createdAt ?? Date.now(),
    );
  } catch {
    // Legacy harnesses may not define this table yet.
  }
}

export function listTaskQualityRunsForTask(db: DbLike, taskId: string, limit = 20): TaskQualityRun[] {
  try {
    const rows = db
      .prepare(
        `
          SELECT
            id,
            task_id,
            quality_item_id,
            run_type,
            name,
            command,
            status,
            exit_code,
            summary,
            output_excerpt,
            metadata_json,
            started_at,
            completed_at,
            created_at
          FROM task_quality_runs
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(taskId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      task_id: String(row.task_id ?? taskId),
      quality_item_id: typeof row.quality_item_id === "string" && row.quality_item_id ? row.quality_item_id : null,
      run_type: String(row.run_type ?? "system") as TaskQualityRunType,
      name: String(row.name ?? ""),
      command: typeof row.command === "string" && row.command ? row.command : null,
      status: String(row.status ?? "skipped") as TaskQualityRunStatus,
      exit_code: normalizeNumber(row.exit_code),
      summary: typeof row.summary === "string" && row.summary ? row.summary : null,
      output_excerpt: typeof row.output_excerpt === "string" && row.output_excerpt ? row.output_excerpt : null,
      metadata: safeJsonParseObject(row.metadata_json),
      started_at: normalizeNumber(row.started_at),
      completed_at: normalizeNumber(row.completed_at),
      created_at: Number(row.created_at ?? 0) || 0,
    }));
  } catch {
    return [];
  }
}

export function recordTaskArtifact(db: DbLike, input: RecordTaskArtifactInput): void {
  const metadata = input.metadata ?? null;
  const createdAt = input.createdAt ?? Date.now();
  const archiveId = input.kind === "report_archive" && typeof metadata?.archive_id === "string" ? metadata.archive_id : null;

  try {
    if (archiveId) {
      const existingId = findReportArchiveArtifactId(db, input.taskId, archiveId);
      if (existingId) {
        db.prepare(
          `
            UPDATE task_artifacts
            SET quality_item_id = ?, title = ?, path = ?, mime = ?, size_bytes = ?,
                source = ?, metadata_json = ?, created_at = ?
            WHERE id = ?
          `,
        ).run(
          input.qualityItemId ?? null,
          input.title,
          input.path ?? null,
          input.mime ?? null,
          input.sizeBytes ?? null,
          input.source,
          safeJsonStringify(metadata),
          createdAt,
          existingId,
        );
        return;
      }
    }

    db.prepare(
      `
        INSERT INTO task_artifacts (
          id, task_id, quality_item_id, kind, title, path, mime,
          size_bytes, source, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      randomUUID(),
      input.taskId,
      input.qualityItemId ?? null,
      input.kind,
      input.title,
      input.path ?? null,
      input.mime ?? null,
      input.sizeBytes ?? null,
      input.source,
      safeJsonStringify(metadata),
      createdAt,
    );
  } catch {
    // Legacy harnesses may not define this table yet.
  }
}

export function listTaskArtifactsForTask(db: DbLike, taskId: string, limit = 20): TaskArtifact[] {
  try {
    const rows = db
      .prepare(
        `
          SELECT
            id,
            task_id,
            quality_item_id,
            kind,
            title,
            path,
            mime,
            size_bytes,
            source,
            metadata_json,
            created_at
          FROM task_artifacts
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(taskId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      task_id: String(row.task_id ?? taskId),
      quality_item_id: typeof row.quality_item_id === "string" && row.quality_item_id ? row.quality_item_id : null,
      kind: String(row.kind ?? "other") as TaskArtifactKind,
      title: String(row.title ?? ""),
      path: typeof row.path === "string" && row.path ? row.path : null,
      mime: typeof row.mime === "string" && row.mime ? row.mime : null,
      size_bytes: normalizeNumber(row.size_bytes),
      source: String(row.source ?? "system") as TaskArtifactSource,
      metadata: safeJsonParseObject(row.metadata_json),
      created_at: Number(row.created_at ?? 0) || 0,
    }));
  } catch {
    return [];
  }
}
