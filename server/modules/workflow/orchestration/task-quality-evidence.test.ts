import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  listTaskArtifactsForTask,
  listTaskQualityRunsForTask,
  recordTaskArtifact,
  recordTaskQualityRun,
} from "./task-quality-evidence.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE task_quality_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL
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
  `);
  return db;
}

describe("task quality evidence helpers", () => {
  it("quality run을 기록하고 최신순으로 조회한다", () => {
    const db = setupDb();
    try {
      recordTaskQualityRun(db as any, {
        taskId: "task-1",
        runType: "system",
        name: "first",
        status: "skipped",
        createdAt: 100,
      });
      recordTaskQualityRun(db as any, {
        taskId: "task-1",
        runType: "artifact_check",
        name: "video gate",
        status: "passed",
        summary: "verified",
        metadata: { path: "/tmp/video.mp4" },
        createdAt: 200,
      });

      const runs = listTaskQualityRunsForTask(db as any, "task-1", 20);
      expect(runs).toHaveLength(2);
      expect(runs[0]?.name).toBe("video gate");
      expect(runs[0]?.metadata?.path).toBe("/tmp/video.mp4");
    } finally {
      db.close();
    }
  });

  it("report archive artifact는 archive_id 기준으로 idempotent upsert된다", () => {
    const db = setupDb();
    try {
      recordTaskArtifact(db as any, {
        taskId: "task-1",
        kind: "report_archive",
        title: "archive",
        source: "report_archive",
        metadata: { archive_id: "task-1", updated_at: 100, has_snapshot: true },
        createdAt: 100,
      });
      recordTaskArtifact(db as any, {
        taskId: "task-1",
        kind: "report_archive",
        title: "archive updated",
        source: "report_archive",
        sizeBytes: 321,
        metadata: { archive_id: "task-1", updated_at: 200, has_snapshot: true },
        createdAt: 200,
      });

      const artifacts = listTaskArtifactsForTask(db as any, "task-1", 20);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.title).toBe("archive updated");
      expect(artifacts[0]?.size_bytes).toBe(321);
      expect(artifacts[0]?.metadata?.updated_at).toBe(200);
    } finally {
      db.close();
    }
  });
});
