import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  buildDevelopmentHandoffSummary,
  clearDevelopmentHandoffMetadata,
  decorateTaskWithDevelopmentHandoff,
  upsertDevelopmentHandoffMetadata,
} from "./development-handoff.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      workflow_pack_key TEXT,
      workflow_meta_json TEXT,
      status TEXT,
      updated_at INTEGER
    );
  `);
  return db;
}

describe("development handoff metadata", () => {
  it("preserves existing workflow metadata keys while upserting development_handoff", () => {
    const db = createDb();
    try {
      db.prepare("INSERT INTO tasks (id, workflow_pack_key, workflow_meta_json, status, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(
          "task-1",
          "development",
          JSON.stringify({
            custom: "keep",
            effective_pack_snapshot: { key: "development" },
          }),
          "review",
          10,
        );

      upsertDevelopmentHandoffMetadata(db as any, {
        taskId: "task-1",
        state: "human_review",
        updatedAt: 20,
        prGateStatus: "blocked",
      });

      const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get("task-1") as {
        workflow_meta_json: string;
      };
      const meta = JSON.parse(row.workflow_meta_json);
      expect(meta.custom).toBe("keep");
      expect(meta.effective_pack_snapshot).toEqual({ key: "development" });
      expect(meta.development_handoff).toEqual(
        expect.objectContaining({
          state: "human_review",
          status_snapshot: "review",
          pr_gate_status: "blocked",
        }),
      );
    } finally {
      db.close();
    }
  });

  it("decorates malformed or missing workflow metadata safely", () => {
    expect(
      decorateTaskWithDevelopmentHandoff({
        workflow_pack_key: "development",
        workflow_meta_json: "{bad json",
      }),
    ).toEqual(
      expect.objectContaining({
        development_handoff: null,
      }),
    );
  });

  it("removes only development_handoff when clearing metadata", () => {
    const db = createDb();
    try {
      db.prepare("INSERT INTO tasks (id, workflow_pack_key, workflow_meta_json, status, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(
          "task-2",
          "report",
          JSON.stringify({
            custom: "keep",
            development_handoff: { state: "queued", updated_at: 10, status_snapshot: "inbox", pending_retry: false, pr_gate_status: null, pr_url: null, summary: "Queued" },
          }),
          "inbox",
          10,
        );

      clearDevelopmentHandoffMetadata(db as any, {
        taskId: "task-2",
        updatedAt: 30,
      });

      const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get("task-2") as {
        workflow_meta_json: string;
      };
      const meta = JSON.parse(row.workflow_meta_json);
      expect(meta.custom).toBe("keep");
      expect(meta.development_handoff).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("prefers merge failure summary over generic human review wording", () => {
    expect(
      buildDevelopmentHandoffSummary({
        state: "human_review",
        pendingRetry: false,
        prGateStatus: null,
        mergeStatus: "failed",
      }),
    ).toBe("Merge failed; manual resolution required");
  });
});
