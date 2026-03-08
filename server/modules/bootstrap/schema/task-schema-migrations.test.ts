import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { applyTaskSchemaMigrations, ensureProjectReviewDecisionEventSchema } from "./task-schema-migrations.ts";

describe("task schema migrations", () => {
  it("tasks/subtasks에 V2 orchestration 컬럼을 추가한다", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY);
        CREATE TABLE departments (id TEXT PRIMARY KEY);
        CREATE TABLE agents (id TEXT PRIMARY KEY);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT,
          description TEXT,
          department_id TEXT,
          assigned_agent_id TEXT,
          project_id TEXT,
          status TEXT,
          priority INTEGER,
          task_type TEXT,
          workflow_pack_key TEXT,
          workflow_meta_json TEXT,
          output_format TEXT,
          project_path TEXT,
          result TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          source_task_id TEXT
        );
        CREATE TABLE subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          title TEXT,
          description TEXT,
          status TEXT,
          assigned_agent_id TEXT,
          blocked_reason TEXT,
          cli_tool_use_id TEXT,
          created_at INTEGER,
          completed_at INTEGER,
          target_department_id TEXT,
          delegated_task_id TEXT
        );
        CREATE TABLE task_creation_audits (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          trigger TEXT
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          sender_type TEXT,
          sender_id TEXT,
          receiver_type TEXT,
          receiver_id TEXT,
          content TEXT,
          message_type TEXT,
          task_id TEXT,
          created_at INTEGER
        );
      `);

      applyTaskSchemaMigrations(db as any);

      const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const subtaskCols = db.prepare("PRAGMA table_info(subtasks)").all() as Array<{ name: string }>;
      expect(taskCols.some((col) => col.name === "orchestration_version")).toBe(true);
      expect(taskCols.some((col) => col.name === "orchestration_stage")).toBe(true);
      expect(subtaskCols.some((col) => col.name === "orchestration_phase")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("project_review_decision_events가 start_review_meeting_blocked를 허용하도록 기존 제약을 업그레이드한다", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY
        );

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY
        );

        CREATE TABLE meeting_minutes (
          id TEXT PRIMARY KEY
        );

        CREATE TABLE project_review_decision_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          snapshot_hash TEXT,
          event_type TEXT NOT NULL
            CHECK(event_type IN ('planning_summary','representative_pick','followup_request','start_review_meeting')),
          summary TEXT NOT NULL,
          selected_options_json TEXT,
          note TEXT,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          meeting_id TEXT REFERENCES meeting_minutes(id) ON DELETE SET NULL,
          created_at INTEGER DEFAULT (unixepoch()*1000)
        );
      `);
      db.prepare("INSERT INTO projects (id) VALUES (?)").run("project-1");
      db.prepare(
        `
          INSERT INTO project_review_decision_events (
            project_id, snapshot_hash, event_type, summary, selected_options_json, note, task_id, meeting_id, created_at
          )
          VALUES (?, ?, 'start_review_meeting', ?, NULL, NULL, NULL, NULL, ?)
        `,
      ).run("project-1", "hash-1", "existing event", 1000);

      ensureProjectReviewDecisionEventSchema(db as any);

      const ddl = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_review_decision_events'").get() as
          | { sql?: string }
          | undefined
      )?.sql;
      expect(String(ddl ?? "")).toContain("start_review_meeting_blocked");

      db.prepare(
        `
          INSERT INTO project_review_decision_events (
            project_id, snapshot_hash, event_type, summary, selected_options_json, note, task_id, meeting_id, created_at
          )
          VALUES (?, ?, 'start_review_meeting_blocked', ?, NULL, NULL, NULL, NULL, ?)
        `,
      ).run("project-1", "hash-2", "blocked event", 2000);

      const rows = db
        .prepare("SELECT event_type, summary FROM project_review_decision_events ORDER BY id ASC")
        .all() as Array<{ event_type: string; summary: string }>;
      expect(rows).toEqual([
        { event_type: "start_review_meeting", summary: "existing event" },
        { event_type: "start_review_meeting_blocked", summary: "blocked event" },
      ]);
    } finally {
      db.close();
    }
  });
});
