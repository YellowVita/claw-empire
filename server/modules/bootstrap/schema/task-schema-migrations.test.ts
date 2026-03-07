import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { ensureProjectReviewDecisionEventSchema } from "./task-schema-migrations.ts";

describe("task schema migrations", () => {
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
