import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { registerChatMessageRoutes } from "./chat-routes.ts";

function firstQueryValue(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const first = input[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

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
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      avatar_emoji TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      sender_type TEXT NOT NULL,
      sender_id TEXT,
      receiver_type TEXT NOT NULL,
      receiver_id TEXT,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL,
      task_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function seedMessage(
  db: DatabaseSync,
  input: {
    id: string;
    sender_type: "ceo" | "agent" | "system";
    sender_id?: string | null;
    receiver_type: "agent" | "department" | "all";
    receiver_id?: string | null;
    content: string;
    message_type: string;
    task_id?: string | null;
    created_at: number;
  },
): void {
  db.prepare(
    `
      INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.id,
    input.sender_type,
    input.sender_id ?? null,
    input.receiver_type,
    input.receiver_id ?? null,
    input.content,
    input.message_type,
    input.task_id ?? null,
    input.created_at,
  );
}

describe("registerChatMessageRoutes", () => {
  it("direct agent chat excludes broadcasts from other agents and internal agent-to-agent traffic", async () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO agents (id, name, avatar_emoji) VALUES (?, ?, ?)").run("planning-lead", "Planning", "🧭");
      db.prepare("INSERT INTO agents (id, name, avatar_emoji) VALUES (?, ?, ?)").run("novel-lead", "Novel", "📚");

      seedMessage(db, {
        id: "ceo-direct",
        sender_type: "ceo",
        receiver_type: "agent",
        receiver_id: "planning-lead",
        content: "Need the development plan.",
        message_type: "chat",
        created_at: 1000,
      });
      seedMessage(db, {
        id: "ceo-directive",
        sender_type: "ceo",
        receiver_type: "all",
        content: "Global directive",
        message_type: "directive",
        created_at: 1100,
      });
      seedMessage(db, {
        id: "planning-reply",
        sender_type: "agent",
        sender_id: "planning-lead",
        receiver_type: "agent",
        receiver_id: null,
        content: "I'll handle it.",
        message_type: "chat",
        created_at: 1200,
      });
      seedMessage(db, {
        id: "planning-broadcast",
        sender_type: "agent",
        sender_id: "planning-lead",
        receiver_type: "all",
        content: "Broadcast from planning leader",
        message_type: "chat",
        created_at: 1300,
      });
      seedMessage(db, {
        id: "planning-delegation",
        sender_type: "agent",
        sender_id: "planning-lead",
        receiver_type: "agent",
        receiver_id: "planning-member",
        content: "Please execute task 1",
        message_type: "task_assign",
        created_at: 1400,
      });
      seedMessage(db, {
        id: "foreign-broadcast",
        sender_type: "agent",
        sender_id: "novel-lead",
        receiver_type: "all",
        content: "Other office report",
        message_type: "chat",
        created_at: 1500,
      });

      const app = express();
      registerChatMessageRoutes(
        { app, db, broadcast: vi.fn() },
        {
          IdempotencyConflictError: TestIdempotencyConflictError,
          StorageBusyError: TestStorageBusyError,
          firstQueryValue,
          resolveMessageIdempotencyKey: () => "test-key",
          recordMessageIngressAuditOr503: () => true,
          insertMessageWithIdempotency: async () => {
            throw new Error("not implemented");
          },
          recordAcceptedIngressAuditOrRollback: async () => true,
          normalizeTextField: () => null,
          handleReportRequest: () => false,
          scheduleAgentReply: () => {},
          detectMentions: () => ({ deptIds: [], agentIds: [] }),
          resolveLang: () => "en",
          handleMentionDelegation: () => {},
        },
      );

      const response = await request(app)
        .get("/api/messages")
        .query({ receiver_type: "agent", receiver_id: "planning-lead", limit: 50 })
        .expect(200);

      expect(response.body.messages.map((msg: { id: string }) => msg.id)).toEqual([
        "ceo-direct",
        "ceo-directive",
        "planning-reply",
      ]);
    } finally {
      db.close();
    }
  });
});
