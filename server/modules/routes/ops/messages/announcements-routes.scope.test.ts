import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAnnouncementRoutes } from "./announcements-routes.ts";

class TestIdempotencyConflictError extends Error {
  readonly key: string;

  constructor(key: string) {
    super("idempotency_conflict");
    this.key = key;
  }
}

class TestStorageBusyError extends Error {
  readonly operation: string;
  readonly attempts: number;

  constructor(operation: string, attempts: number) {
    super("storage_busy");
    this.operation = operation;
    this.attempts = attempts;
  }
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      department_id TEXT,
      role TEXT NOT NULL DEFAULT 'team_leader',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

function insertLeader(db: DatabaseSync, id: string, departmentId: string): void {
  db.prepare("INSERT INTO agents (id, name, department_id, role, status, created_at) VALUES (?, ?, ?, 'team_leader', 'idle', 1)").run(
    id,
    id,
    departmentId,
  );
}

function buildFindTeamLeader(db: DatabaseSync) {
  return (departmentId: string | null, candidateAgentIds?: string[] | null) => {
    if (!departmentId) return null;
    const scopedIds = Array.isArray(candidateAgentIds)
      ? [...new Set(candidateAgentIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : null;
    if (Array.isArray(scopedIds) && scopedIds.length <= 0) return null;
    const scopeClause = Array.isArray(scopedIds) ? `AND id IN (${scopedIds.map(() => "?").join(",")})` : "";
    return (
      db
        .prepare(
          `
          SELECT *
          FROM agents
          WHERE department_id = ?
            AND role = 'team_leader'
            AND status != 'offline'
            ${scopeClause}
          ORDER BY created_at ASC
          LIMIT 1
        `,
        )
        .get(departmentId, ...(scopedIds ?? [])) ?? null
    );
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("registerAnnouncementRoutes - office pack scope", () => {
  it("uses active office pack scope for auto replies and mention delegation", async () => {
    vi.useFakeTimers();
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          report: {
            departments: [{ id: "planning" }, { id: "dev" }],
            agents: [
              { id: "report-seed-1", department_id: "planning" },
              { id: "report-seed-2", department_id: "dev" },
            ],
          },
        }),
      );

      insertLeader(db, "planning-global", "planning");
      insertLeader(db, "dev-global", "dev");
      insertLeader(db, "report-seed-1", "planning");
      insertLeader(db, "report-seed-2", "dev");

      const scheduleAnnouncementReplies = vi.fn();
      const handleTaskDelegation = vi.fn();
      const app = express();
      app.use(express.json());

      registerAnnouncementRoutes(
        { app, db, broadcast: vi.fn() as any },
        {
          IdempotencyConflictError: TestIdempotencyConflictError,
          StorageBusyError: TestStorageBusyError,
          resolveMessageIdempotencyKey: () => "ann-key",
          recordMessageIngressAuditOr503: () => true,
          insertMessageWithIdempotency: async () => ({
            created: true,
            message: {
              id: "msg-1",
              sender_type: "ceo",
              sender_id: null,
              receiver_type: "all",
              receiver_id: null,
              content: "공지",
              message_type: "announcement",
              task_id: null,
              idempotency_key: "ann-key",
              created_at: Date.now(),
            },
          }),
          recordAcceptedIngressAuditOrRollback: async () => true,
          scheduleAnnouncementReplies,
          detectMentions: () => ({ deptIds: ["dev"], agentIds: [] }),
          findTeamLeader: buildFindTeamLeader(db) as any,
          handleTaskDelegation,
        },
      );

      await request(app).post("/api/announcements").send({ content: "@dev 점검" }).expect(200);
      await vi.runAllTimersAsync();

      expect(scheduleAnnouncementReplies).toHaveBeenCalledTimes(1);
      const candidateIds = scheduleAnnouncementReplies.mock.calls[0]?.[1] as string[] | null | undefined;
      expect(candidateIds).toEqual(expect.arrayContaining(["planning-global", "dev-global"]));
      expect(candidateIds).not.toEqual(expect.arrayContaining(["report-seed-1", "report-seed-2"]));
      expect(handleTaskDelegation).toHaveBeenCalledTimes(1);
      expect(handleTaskDelegation.mock.calls[0]?.[0]?.id).toBe("dev-global");
    } finally {
      db.close();
    }
  });
});
