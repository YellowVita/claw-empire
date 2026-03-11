import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  buildSyntheticQueuedTaskRunSheet,
  readTaskRunSheetForTask,
  renderTaskRunSheetMarkdown,
  upsertTaskRunSheet,
} from "./task-run-sheets.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      workflow_pack_key TEXT NOT NULL DEFAULT 'development',
      project_path TEXT,
      result TEXT,
      source_task_id TEXT,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_type TEXT NOT NULL
    );
    CREATE TABLE task_quality_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      details TEXT,
      required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      evidence_markdown TEXT,
      source TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE task_quality_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      quality_item_id TEXT,
      run_type TEXT NOT NULL,
      name TEXT NOT NULL,
      command TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      summary TEXT,
      output_excerpt TEXT,
      metadata_json TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      quality_item_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT,
      mime TEXT,
      size_bytes INTEGER,
      source TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_execution_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      attempt_count INTEGER,
      hook_source TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_retry_queue (
      task_id TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE task_run_sheets (
      task_id TEXT PRIMARY KEY,
      workflow_pack_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_markdown TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe("task run sheets", () => {
  it("development task run sheet를 upsert하고 validation evidence를 반영한다", () => {
    const db = setupDb();
    try {
      db.prepare(
        "INSERT INTO tasks (id, title, description, status, workflow_pack_key, project_path, result, created_at, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "task-1",
        "Ship feature",
        "Reproduction: click the button and observe timeout",
        "review",
        "development",
        "/tmp/project",
        "Implemented timeout guard",
        1000,
        1100,
        1900,
      );
      db.prepare("INSERT INTO messages (id, task_id, content, created_at, message_type) VALUES (?, ?, ?, ?, ?)").run(
        "msg-1",
        "task-1",
        "Final report with remediation details",
        1800,
        "report",
      );
      db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
        "task-1",
        "system",
        "Status → review (team leader review pending)",
        1900,
      );
      db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
        "task-1",
        "system",
        "Worktree diff summary:\nM src/app.ts",
        1850,
      );
      db.prepare(
        "INSERT INTO task_quality_items (id, task_id, kind, label, details, required, status, evidence_markdown, source, sort_order, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("quality-1", "task-1", "validation", "Unit tests", null, 1, "passed", null, "system", 0, 1000, 1800, 1800);
      db.prepare(
        "INSERT INTO task_quality_runs (id, task_id, quality_item_id, run_type, name, status, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("run-1", "task-1", null, "command", "pnpm test", "passed", "42 passed", 1810);
      db.prepare(
        "INSERT INTO task_quality_runs (id, task_id, quality_item_id, run_type, name, status, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "run-2",
        "task-1",
        null,
        "system",
        "github_pr_feedback_gate",
        "failed",
        "GitHub PR feedback gate blocked",
        JSON.stringify({
          applicable: true,
          status: "blocked",
          pr_url: "https://github.com/acme/repo/pull/12",
          unresolved_thread_count: 2,
          change_requests_count: 1,
          failing_check_count: 1,
          pending_check_count: 0,
          blocking_reasons: ["Unresolved review threads: 2"],
          checked_at: 1825,
        }),
        1825,
      );
      db.prepare(
        "INSERT INTO task_artifacts (id, task_id, quality_item_id, kind, title, path, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("artifact-1", "task-1", null, "file", "coverage.txt", "/tmp/project/coverage.txt", "system", 1820);

      upsertTaskRunSheet(db as any, {
        taskId: "task-1",
        stage: "review_ready",
        updatedAt: 2000,
      });

      const row = readTaskRunSheetForTask(db as any, "task-1");
      expect(row).toEqual(
        expect.objectContaining({
          task_id: "task-1",
          stage: "review_ready",
          status: "review",
          synthetic: false,
        }),
      );
      expect(row?.snapshot.reproduction.status).toBe("recorded");
      expect(row?.snapshot.validation.recent_runs[0]).toEqual(
        expect.objectContaining({
          name: "github_pr_feedback_gate",
          status: "failed",
        }),
      );
      expect(row?.snapshot.validation.recent_runs[1]).toEqual(
        expect.objectContaining({
          name: "pnpm test",
          status: "passed",
        }),
      );
      expect(row?.snapshot.review_checklist.pr_feedback_gate).toEqual(
        expect.objectContaining({
          status: "blocked",
          unresolved_thread_count: 2,
          pr_url: "https://github.com/acme/repo/pull/12",
        }),
      );
      expect(row?.snapshot.validation.artifacts[0]).toEqual(
        expect.objectContaining({
          title: "coverage.txt",
        }),
      );
      expect(row?.summary_markdown).toContain("## Validation");
      expect(row?.summary_markdown).toContain("pnpm test");
      expect(row?.summary_markdown).toContain("PR Feedback Gate: blocked");
    } finally {
      db.close();
    }
  });

  it("같은 snapshot이면 markdown 렌더링 결과가 동일하다", () => {
    const markdownA = renderTaskRunSheetMarkdown({
      stage: "in_progress",
      status: "in_progress",
      snapshot: {
        current_plan: { title: "Task", description: "Desc", latest_report: null, project_path: "/tmp/project" },
        reproduction: { status: "not_recorded", evidence: [] },
        implementation: { result_summary: "Done", latest_report: null, diff_summary: null, log_highlights: [] },
        validation: {
          required_total: 1,
          passed: 1,
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
        handoff: { status: "in_progress", summary: "Working" },
        timeline: {
          created_at: 1,
          started_at: 2,
          review_entered_at: null,
          completed_at: null,
          updated_at: 3,
        },
      },
    });
    const markdownB = renderTaskRunSheetMarkdown({
      stage: "in_progress",
      status: "in_progress",
      snapshot: {
        current_plan: { title: "Task", description: "Desc", latest_report: null, project_path: "/tmp/project" },
        reproduction: { status: "not_recorded", evidence: [] },
        implementation: { result_summary: "Done", latest_report: null, diff_summary: null, log_highlights: [] },
        validation: {
          required_total: 1,
          passed: 1,
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
        handoff: { status: "in_progress", summary: "Working" },
        timeline: {
          created_at: 1,
          started_at: 2,
          review_entered_at: null,
          completed_at: null,
          updated_at: 3,
        },
      },
    });

    expect(markdownA).toBe(markdownB);
  });

  it("run sheet row가 없으면 pending development task에 synthetic queued를 제공한다", () => {
    const db = setupDb();
    try {
      db.prepare(
        "INSERT INTO tasks (id, title, description, status, workflow_pack_key, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("task-queued", "Queued task", "Waiting", "pending", "development", "/tmp/project", 100, 120);

      const runSheet = buildSyntheticQueuedTaskRunSheet(db as any, "task-queued");
      expect(runSheet).toEqual(
        expect.objectContaining({
          task_id: "task-queued",
          stage: "queued",
          status: "pending",
          synthetic: true,
        }),
      );
      expect(runSheet?.summary_markdown).toContain("Stage: queued");
    } finally {
      db.close();
    }
  });
});
