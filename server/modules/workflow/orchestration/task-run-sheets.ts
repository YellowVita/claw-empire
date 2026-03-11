import type { DatabaseSync } from "node:sqlite";
import { buildTaskQualityPayload } from "../../routes/core/tasks/quality.ts";
import type { TaskQualityRun } from "./task-quality-evidence.ts";
import { summarizeTaskExecutionEvents } from "./task-execution-events.ts";
import { syncDevelopmentHandoffFromRunSheet } from "./development-handoff.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

export type TaskRunSheetStage =
  | "queued"
  | "in_progress"
  | "review_ready"
  | "human_review"
  | "merging"
  | "done"
  | "rework";

export type TaskRunSheetEvidenceState = "recorded" | "not_recorded";

export type TaskRunSheetPrFeedbackGate = {
  applicable: boolean;
  status: "passed" | "blocked" | "skipped";
  pr_url: string | null;
  unresolved_thread_count: number;
  change_requests_count: number;
  failing_check_count: number;
  pending_check_count: number;
  blocking_reasons: string[];
  checked_at: number | null;
};

export type TaskRunSheetSnapshot = {
  current_plan: {
    title: string;
    description: string | null;
    latest_report: string | null;
    project_path: string | null;
  };
  reproduction: {
    status: TaskRunSheetEvidenceState;
    evidence: string[];
  };
  implementation: {
    result_summary: string | null;
    latest_report: string | null;
    diff_summary: string | null;
    log_highlights: string[];
  };
  validation: {
    required_total: number;
    passed: number;
    failed: number;
    pending: number;
    blocked_review: boolean;
    pending_retry: boolean;
    recent_runs: Array<{
      name: string;
      status: string;
      summary: string | null;
      created_at: number;
    }>;
    artifacts: Array<{
      title: string;
      kind: string;
      path: string | null;
      created_at: number;
    }>;
  };
  review_checklist: {
    entered_review: boolean;
    blocked_review: boolean;
    waiting_on_subtasks: boolean;
    waiting_on_child_reviews: boolean;
    pending_retry: boolean;
    merge_status: "not_started" | "merged" | "failed";
    pr_feedback_gate: TaskRunSheetPrFeedbackGate | null;
  };
  handoff: {
    status: string;
    summary: string | null;
  };
  timeline: {
    created_at: number | null;
    started_at: number | null;
    review_entered_at: number | null;
    completed_at: number | null;
    updated_at: number | null;
  };
};

export type TaskRunSheet = {
  task_id: string;
  workflow_pack_key: string;
  stage: TaskRunSheetStage;
  status: string;
  summary_markdown: string;
  snapshot: TaskRunSheetSnapshot;
  created_at: number;
  updated_at: number;
  synthetic: boolean;
};

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  workflow_pack_key: string | null;
  project_path: string | null;
  result: string | null;
  source_task_id: string | null;
  created_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number | null;
};

type TaskLogRow = {
  kind: string;
  message: string;
  created_at: number;
};

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clipText(value: string | null | undefined, maxChars = 280): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const collapsed = normalized.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars).trimEnd()}...`;
}

function safeJsonStringify(value: TaskRunSheetSnapshot): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(buildEmptySnapshot());
  }
}

function safeJsonParseSnapshot(value: unknown): TaskRunSheetSnapshot | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as TaskRunSheetSnapshot;
  } catch {
    return null;
  }
}

function buildEmptySnapshot(): TaskRunSheetSnapshot {
  return {
    current_plan: {
      title: "",
      description: null,
      latest_report: null,
      project_path: null,
    },
    reproduction: {
      status: "not_recorded",
      evidence: [],
    },
    implementation: {
      result_summary: null,
      latest_report: null,
      diff_summary: null,
      log_highlights: [],
    },
    validation: {
      required_total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      blocked_review: false,
      pending_retry: false,
      recent_runs: [],
      artifacts: [],
    },
    review_checklist: {
      entered_review: false,
      blocked_review: false,
      waiting_on_subtasks: false,
      waiting_on_child_reviews: false,
      pending_retry: false,
      merge_status: "not_started",
      pr_feedback_gate: null,
    },
    handoff: {
      status: "",
      summary: null,
    },
    timeline: {
      created_at: null,
      started_at: null,
      review_entered_at: null,
      completed_at: null,
      updated_at: null,
    },
  };
}

function loadTaskRow(db: DbLike, taskId: string): TaskRow | null {
  const normalizeRow = (row: Record<string, unknown>): TaskRow => ({
    id: String(row.id ?? taskId),
    title: String(row.title ?? ""),
    description: normalizeText(row.description),
    status: String(row.status ?? ""),
    workflow_pack_key: normalizeText(row.workflow_pack_key),
    project_path: normalizeText(row.project_path),
    result: normalizeText(row.result),
    source_task_id: normalizeText(row.source_task_id),
    created_at: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0) || null,
    started_at: typeof row.started_at === "number" ? row.started_at : Number(row.started_at ?? 0) || null,
    completed_at: typeof row.completed_at === "number" ? row.completed_at : Number(row.completed_at ?? 0) || null,
    updated_at: typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at ?? 0) || null,
  });
  try {
    const row = db
      .prepare(
        `
          SELECT
            id,
            title,
            description,
            status,
            workflow_pack_key,
            project_path,
            result,
            source_task_id,
            created_at,
            started_at,
            completed_at,
            updated_at
          FROM tasks
          WHERE id = ?
        `,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return normalizeRow(row);
  } catch {
    try {
      const row = db
        .prepare(
          `
            SELECT
              id,
              title,
              description,
              status,
              workflow_pack_key,
              project_path,
              result,
              source_task_id,
              created_at,
              started_at,
              completed_at
            FROM tasks
            WHERE id = ?
          `,
        )
        .get(taskId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return normalizeRow(row);
    } catch {
      return null;
    }
  }
}

function listTaskLogs(db: DbLike, taskId: string, limit = 40): TaskLogRow[] {
  try {
    return db
      .prepare(
        `
          SELECT kind, message, created_at
          FROM task_logs
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(taskId, limit) as TaskLogRow[];
  } catch {
    return [];
  }
}

function loadLatestReportMessage(db: DbLike, taskId: string): string | null {
  try {
    const row = db
      .prepare(
        `
          SELECT content
          FROM messages
          WHERE task_id = ? AND message_type = 'report'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(taskId) as { content?: unknown } | undefined;
    return normalizeText(row?.content);
  } catch {
    return null;
  }
}

function extractDiffSummary(logs: TaskLogRow[]): string | null {
  for (const log of logs) {
    const message = normalizeText(log.message);
    if (!message) continue;
    const match = message.match(/^Worktree diff summary:\s*([\s\S]+)$/i);
    if (match?.[1]) return clipText(match[1], 600);
  }
  return null;
}

function extractReviewEnteredAt(logs: TaskLogRow[]): number | null {
  const ordered = [...logs].reverse();
  for (const log of ordered) {
    const message = normalizeText(log.message);
    if (!message) continue;
    if (/^Status\s*[→-]>\s*review\b/i.test(message)) {
      return Number(log.created_at ?? 0) || null;
    }
  }
  return null;
}

function extractMergeStatus(logs: TaskLogRow[]): "not_started" | "merged" | "failed" {
  for (const log of logs) {
    const message = normalizeText(log.message);
    if (!message) continue;
    if (/^Git merge completed:/i.test(message)) return "merged";
    if (/^Git merge failed:/i.test(message)) return "failed";
  }
  return "not_started";
}

function extractReproductionEvidence(task: TaskRow, latestReport: string | null, logs: TaskLogRow[]): string[] {
  const evidence = new Set<string>();
  const pushText = (value: string | null) => {
    const clipped = clipText(value, 220);
    if (clipped) evidence.add(clipped);
  };

  const description = task.description ?? "";
  const report = latestReport ?? "";
  const reproductionMatches = [
    ...description.matchAll(/(?:repro|reproduction|steps to reproduce|재현|재현 단계)[:\s-]+(.+)/gi),
    ...report.matchAll(/(?:repro|reproduction|steps to reproduce|재현|재현 단계)[:\s-]+(.+)/gi),
  ];
  for (const match of reproductionMatches) {
    pushText(match[1] ?? null);
  }

  for (const log of logs) {
    const message = normalizeText(log.message);
    if (!message) continue;
    if (/repro|reproduction|steps to reproduce|재현/i.test(message)) {
      pushText(message);
    }
  }

  return [...evidence];
}

function extractImplementationHighlights(logs: TaskLogRow[]): string[] {
  const highlights: string[] = [];
  for (const log of logs) {
    const message = normalizeText(log.message);
    if (!message) continue;
    if (
      /^RUN /i.test(message) ||
      /^Git worktree created:/i.test(message) ||
      /^Worktree diff summary:/i.test(message) ||
      /^Status\s*[→-]>\s*(review|pending|done)/i.test(message)
    ) {
      const clipped = clipText(message, 220);
      if (clipped && !highlights.includes(clipped)) highlights.push(clipped);
    }
    if (highlights.length >= 4) break;
  }
  return highlights;
}

function extractGithubPrFeedbackGate(runs: TaskQualityRun[]): TaskRunSheetPrFeedbackGate | null {
  const gateRun = runs.find((run) => run.name === "github_pr_feedback_gate");
  if (!gateRun?.metadata) return null;
  const metadata = gateRun.metadata;
  const blockingReasons = Array.isArray(metadata.blocking_reasons)
    ? metadata.blocking_reasons
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, 6)
    : [];
  const status =
    gateRun.status === "passed" || gateRun.status === "failed" || gateRun.status === "skipped"
      ? gateRun.status
      : "skipped";
  return {
    applicable: metadata.applicable !== false,
    status: status === "failed" ? "blocked" : status,
    pr_url: typeof metadata.pr_url === "string" && metadata.pr_url.trim() ? metadata.pr_url : null,
    unresolved_thread_count: Number(metadata.unresolved_thread_count ?? 0) || 0,
    change_requests_count: Number(metadata.change_requests_count ?? 0) || 0,
    failing_check_count: Number(metadata.failing_check_count ?? 0) || 0,
    pending_check_count: Number(metadata.pending_check_count ?? 0) || 0,
    blocking_reasons: blockingReasons,
    checked_at: Number(metadata.checked_at ?? gateRun.created_at ?? 0) || null,
  };
}

function countUnfinishedSubtasks(db: DbLike, taskId: string): number {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS cnt FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')")
      .get(taskId) as { cnt?: number } | undefined;
    return Number(row?.cnt ?? 0) || 0;
  } catch {
    return 0;
  }
}

function countChildTasksWaitingForReview(db: DbLike, taskId: string, sourceTaskId: string | null): number {
  if (sourceTaskId) return 0;
  try {
    const row = db
      .prepare(
        `
          SELECT COUNT(*) AS cnt
          FROM tasks
          WHERE source_task_id = ?
            AND status NOT IN ('review', 'done', 'cancelled')
        `,
      )
      .get(taskId) as { cnt?: number } | undefined;
    return Number(row?.cnt ?? 0) || 0;
  } catch {
    return 0;
  }
}

function joinLines(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
}

export function renderTaskRunSheetMarkdown(input: {
  stage: TaskRunSheetStage;
  status: string;
  snapshot: TaskRunSheetSnapshot;
}): string {
  const { stage, status, snapshot } = input;
  const lines: string[] = [
    "# Development Run Sheet",
    "",
    `- Stage: ${stage}`,
    `- Task Status: ${status || "-"}`,
    "",
    "## Current Plan",
    `- Title: ${snapshot.current_plan.title || "-"}`,
    `- Description: ${snapshot.current_plan.description || "-"}`,
    `- Latest Report: ${snapshot.current_plan.latest_report || "-"}`,
    `- Project Path: ${snapshot.current_plan.project_path || "-"}`,
    "",
    "## Reproduction",
    `- Status: ${snapshot.reproduction.status}`,
    ...(
      snapshot.reproduction.evidence.length > 0
        ? snapshot.reproduction.evidence.map((entry) => `- Evidence: ${entry}`)
        : ["- Evidence: -"]
    ),
    "",
    "## Implementation",
    `- Result Summary: ${snapshot.implementation.result_summary || "-"}`,
    `- Latest Report: ${snapshot.implementation.latest_report || "-"}`,
    `- Diff Summary: ${snapshot.implementation.diff_summary || "-"}`,
    ...(
      snapshot.implementation.log_highlights.length > 0
        ? snapshot.implementation.log_highlights.map((entry) => `- Highlight: ${entry}`)
        : ["- Highlight: -"]
    ),
    "",
    "## Validation",
    `- Required: ${snapshot.validation.required_total}`,
    `- Passed: ${snapshot.validation.passed}`,
    `- Failed: ${snapshot.validation.failed}`,
    `- Pending: ${snapshot.validation.pending}`,
    `- Blocked Review: ${snapshot.validation.blocked_review ? "yes" : "no"}`,
    `- Pending Retry: ${snapshot.validation.pending_retry ? "yes" : "no"}`,
    ...(
      snapshot.validation.recent_runs.length > 0
        ? snapshot.validation.recent_runs.map(
            (run) => `- Run: ${run.name} [${run.status}]${run.summary ? ` - ${run.summary}` : ""}`,
          )
        : ["- Run: -"]
    ),
    ...(
      snapshot.validation.artifacts.length > 0
        ? snapshot.validation.artifacts.map(
            (artifact) => `- Artifact: ${artifact.title} (${artifact.kind})${artifact.path ? ` - ${artifact.path}` : ""}`,
          )
        : ["- Artifact: -"]
    ),
    "",
    "## Review Checklist",
    `- Entered Review: ${snapshot.review_checklist.entered_review ? "yes" : "no"}`,
    `- Blocked Review: ${snapshot.review_checklist.blocked_review ? "yes" : "no"}`,
    `- Waiting On Subtasks: ${snapshot.review_checklist.waiting_on_subtasks ? "yes" : "no"}`,
    `- Waiting On Child Reviews: ${snapshot.review_checklist.waiting_on_child_reviews ? "yes" : "no"}`,
    `- Pending Retry: ${snapshot.review_checklist.pending_retry ? "yes" : "no"}`,
    `- Merge Status: ${snapshot.review_checklist.merge_status}`,
    `- PR Feedback Gate: ${snapshot.review_checklist.pr_feedback_gate?.status || "-"}`,
    `- PR URL: ${snapshot.review_checklist.pr_feedback_gate?.pr_url || "-"}`,
    `- Unresolved Threads: ${snapshot.review_checklist.pr_feedback_gate?.unresolved_thread_count ?? "-"}`,
    `- Change Requests: ${snapshot.review_checklist.pr_feedback_gate?.change_requests_count ?? "-"}`,
    `- Failing Checks: ${snapshot.review_checklist.pr_feedback_gate?.failing_check_count ?? "-"}`,
    `- Pending Checks: ${snapshot.review_checklist.pr_feedback_gate?.pending_check_count ?? "-"}`,
    ...(
      snapshot.review_checklist.pr_feedback_gate?.blocking_reasons?.length
        ? snapshot.review_checklist.pr_feedback_gate.blocking_reasons.map((reason) => `- PR Gate Reason: ${reason}`)
        : ["- PR Gate Reason: -"]
    ),
    "",
    "## Handoff",
    `- Status: ${snapshot.handoff.status || "-"}`,
    `- Summary: ${snapshot.handoff.summary || "-"}`,
    "",
    "## Timeline",
    `- Created At: ${snapshot.timeline.created_at ?? "-"}`,
    `- Started At: ${snapshot.timeline.started_at ?? "-"}`,
    `- Review Entered At: ${snapshot.timeline.review_entered_at ?? "-"}`,
    `- Completed At: ${snapshot.timeline.completed_at ?? "-"}`,
    `- Updated At: ${snapshot.timeline.updated_at ?? "-"}`,
  ];
  return joinLines(lines).trim();
}

export function buildTaskRunSheetSnapshot(db: DbLike, params: {
  taskId: string;
  stage: TaskRunSheetStage;
  updatedAt?: number | null;
}): TaskRunSheetSnapshot | null {
  const task = loadTaskRow(db, params.taskId);
  if (!task || task.workflow_pack_key !== "development") return null;

  const logs = listTaskLogs(db, task.id, 40);
  const latestReport = loadLatestReportMessage(db, task.id);
  const quality = buildTaskQualityPayload(db as any, task.id);
  const executionSummary = summarizeTaskExecutionEvents(db as any, task.id);
  const prFeedbackGate = extractGithubPrFeedbackGate(quality.runs as TaskQualityRun[]);
  const reviewEnteredAt = extractReviewEnteredAt(logs);
  const unfinishedSubtasks = countUnfinishedSubtasks(db, task.id);
  const waitingChildReviews = countChildTasksWaitingForReview(db, task.id, task.source_task_id);
  const resultSummary = clipText(task.result, 320);
  const diffSummary = extractDiffSummary(logs);
  const implementationHighlights = extractImplementationHighlights(logs);
  const reproductionEvidence = extractReproductionEvidence(task, latestReport, logs);
  const handoffSummary =
    clipText(latestReport, 320) ??
    resultSummary ??
    clipText(logs[0]?.message ?? null, 320);

  return {
    current_plan: {
      title: task.title,
      description: clipText(task.description, 320),
      latest_report: clipText(latestReport, 320),
      project_path: task.project_path,
    },
    reproduction: {
      status: reproductionEvidence.length > 0 ? "recorded" : "not_recorded",
      evidence: reproductionEvidence,
    },
    implementation: {
      result_summary: resultSummary,
      latest_report: clipText(latestReport, 320),
      diff_summary: diffSummary,
      log_highlights: implementationHighlights,
    },
    validation: {
      required_total: quality.summary.required_total,
      passed: quality.summary.passed,
      failed: quality.summary.failed,
      pending: quality.summary.pending,
      blocked_review: quality.summary.blocked_review,
      pending_retry: executionSummary.pending_retry,
      recent_runs: quality.runs.slice(0, 5).map((run) => ({
        name: run.name,
        status: run.status,
        summary: clipText(run.summary, 180),
        created_at: run.created_at,
      })),
      artifacts: quality.artifacts.slice(0, 5).map((artifact) => ({
        title: artifact.title,
        kind: artifact.kind,
        path: artifact.path,
        created_at: artifact.created_at,
      })),
    },
    review_checklist: {
      entered_review: reviewEnteredAt != null || params.stage === "review_ready" || params.stage === "human_review" || params.stage === "merging" || params.stage === "done",
      blocked_review: quality.summary.blocked_review,
      waiting_on_subtasks: unfinishedSubtasks > 0,
      waiting_on_child_reviews: waitingChildReviews > 0,
      pending_retry: executionSummary.pending_retry,
      merge_status: extractMergeStatus(logs),
      pr_feedback_gate: prFeedbackGate,
    },
    handoff: {
      status: task.status,
      summary: handoffSummary,
    },
    timeline: {
      created_at: task.created_at,
      started_at: task.started_at,
      review_entered_at: reviewEnteredAt,
      completed_at: task.completed_at,
      updated_at: params.updatedAt ?? task.updated_at,
    },
  };
}

export function upsertTaskRunSheet(db: DbLike, input: {
  taskId: string;
  stage: TaskRunSheetStage;
  updatedAt?: number;
}): void {
  const task = loadTaskRow(db, input.taskId);
  if (!task || task.workflow_pack_key !== "development") return;

  const snapshot = buildTaskRunSheetSnapshot(db, {
    taskId: input.taskId,
    stage: input.stage,
    updatedAt: input.updatedAt ?? Date.now(),
  });
  if (!snapshot) return;

  const updatedAt = input.updatedAt ?? Date.now();
  const createdAt = task.created_at ?? updatedAt;
  const summaryMarkdown = renderTaskRunSheetMarkdown({
    stage: input.stage,
    status: task.status,
    snapshot,
  });

  try {
    db.prepare(
      `
        INSERT INTO task_run_sheets (
          task_id,
          workflow_pack_key,
          stage,
          status,
          summary_markdown,
          snapshot_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          workflow_pack_key = excluded.workflow_pack_key,
          stage = excluded.stage,
          status = excluded.status,
          summary_markdown = excluded.summary_markdown,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
      `,
    ).run(
      input.taskId,
      "development",
      input.stage,
      task.status,
      summaryMarkdown,
      safeJsonStringify(snapshot),
      createdAt,
      updatedAt,
    );
  } catch {
    // Legacy harnesses may not define this table yet.
  }

  syncDevelopmentHandoffFromRunSheet(db, {
    taskId: input.taskId,
    stage: input.stage,
    snapshot,
    updatedAt,
  });
}

export function readTaskRunSheetForTask(db: DbLike, taskId: string): TaskRunSheet | null {
  try {
    const row = db
      .prepare(
        `
          SELECT
            task_id,
            workflow_pack_key,
            stage,
            status,
            summary_markdown,
            snapshot_json,
            created_at,
            updated_at
          FROM task_run_sheets
          WHERE task_id = ?
          LIMIT 1
        `,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const snapshot = safeJsonParseSnapshot(row.snapshot_json);
    if (!snapshot) return null;
    return {
      task_id: String(row.task_id ?? taskId),
      workflow_pack_key: String(row.workflow_pack_key ?? "development"),
      stage: String(row.stage ?? "queued") as TaskRunSheetStage,
      status: String(row.status ?? ""),
      summary_markdown: String(row.summary_markdown ?? ""),
      snapshot,
      created_at: Number(row.created_at ?? 0) || 0,
      updated_at: Number(row.updated_at ?? 0) || 0,
      synthetic: false,
    };
  } catch {
    return null;
  }
}

function isSyntheticQueuedCandidate(task: TaskRow): boolean {
  if (task.workflow_pack_key !== "development") return false;
  if (task.started_at) return false;
  return ["inbox", "planned", "pending", "collaborating"].includes(task.status);
}

export function buildSyntheticQueuedTaskRunSheet(db: DbLike, taskId: string): TaskRunSheet | null {
  const task = loadTaskRow(db, taskId);
  if (!task || !isSyntheticQueuedCandidate(task)) return null;
  const snapshot = buildTaskRunSheetSnapshot(db, {
    taskId,
    stage: "queued",
    updatedAt: task.updated_at ?? task.created_at ?? Date.now(),
  });
  if (!snapshot) return null;
  return {
    task_id: task.id,
    workflow_pack_key: "development",
    stage: "queued",
    status: task.status,
    summary_markdown: renderTaskRunSheetMarkdown({
      stage: "queued",
      status: task.status,
      snapshot,
    }),
    snapshot,
    created_at: task.created_at ?? 0,
    updated_at: task.updated_at ?? task.created_at ?? 0,
    synthetic: true,
  };
}
