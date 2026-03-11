import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { encryptMessengerChannelsForStorage } from "../../../messenger/token-crypto.ts";
import { registerOpsSettingsStatsRoutes } from "./settings-stats.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🏢',
      color TEXT NOT NULL DEFAULT '#64748b',
      description TEXT,
      prompt TEXT,
      sort_order INTEGER NOT NULL DEFAULT 99,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      department_id TEXT,
      role TEXT NOT NULL DEFAULT 'senior',
      acts_as_planning_leader INTEGER NOT NULL DEFAULT 0,
      cli_provider TEXT,
      avatar_emoji TEXT NOT NULL DEFAULT '🤖',
      personality TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      current_task_id TEXT,
      stats_tasks_done INTEGER NOT NULL DEFAULT 0,
      stats_xp INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      sprite_number INTEGER,
      cli_model TEXT,
      cli_reasoning_level TEXT
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT,
      department_id TEXT,
      title TEXT,
      updated_at INTEGER,
      assigned_agent_id TEXT
    );

    CREATE TABLE task_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      created_at INTEGER
    );
  `);
  return db;
}

function createHarness(db: DatabaseSync) {
  const getRoutes = new Map<string, RouteHandler>();
  const putRoutes = new Map<string, RouteHandler>();
  const app = {
    get(routePath: string, handler: RouteHandler) {
      getRoutes.set(routePath, handler);
      return this;
    },
    put(routePath: string, handler: RouteHandler) {
      putRoutes.set(routePath, handler);
      return this;
    },
  };

  registerOpsSettingsStatsRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => 1_700_000_000_000,
  } as any);

  return {
    getHandler: getRoutes.get("/api/settings"),
    putHandler: putRoutes.get("/api/settings"),
  };
}

function seedMessengerSettings(db: DatabaseSync, value: unknown) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("messengerChannels", JSON.stringify(value));
}

function readStoredMessengerSettings(db: DatabaseSync): Record<string, any> {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("messengerChannels") as { value: string };
  return JSON.parse(row.value) as Record<string, any>;
}

describe("ops settings secret contract", () => {
  it("GET /api/settings returns masked/configured metadata without plaintext tokens", () => {
    const db = setupDb();
    try {
      seedMessengerSettings(
        db,
        encryptMessengerChannelsForStorage({
          telegram: {
            token: "telegram-root-token-1234",
            sessions: [
              {
                id: "ops",
                name: "Ops",
                targetId: "-100123",
                enabled: true,
                token: "session-secret-6789",
              },
            ],
          },
        }),
      );

      const { getHandler } = createHarness(db);
      const res = createFakeResponse();
      getHandler?.({}, res);

      expect(res.statusCode).toBe(200);
      const settings = (res.payload as { settings: Record<string, any> }).settings;
      const telegram = settings.messengerChannels.telegram;
      expect(telegram.token).toBeUndefined();
      expect(telegram.tokenConfigured).toBe(true);
      expect(telegram.tokenMasked).toBe("****1234");
      expect(telegram.sessions[0].token).toBeUndefined();
      expect(telegram.sessions[0].tokenConfigured).toBe(true);
      expect(telegram.sessions[0].tokenMasked).toBe("****6789");
    } finally {
      db.close();
    }
  });

  it("PUT /api/settings preserves existing encrypted messenger token on blank update", () => {
    const db = setupDb();
    try {
      seedMessengerSettings(
        db,
        encryptMessengerChannelsForStorage({
          telegram: {
            token: "persist-me-1111",
            sessions: [{ id: "ops", name: "Ops", targetId: "-100123", enabled: true, token: "session-9999" }],
          },
        }),
      );
      const previous = readStoredMessengerSettings(db);
      const { putHandler } = createHarness(db);
      const res = createFakeResponse();

      putHandler?.(
        {
          body: {
            messengerChannels: {
              telegram: {
                token: "",
                sessions: [{ id: "ops", name: "Ops", targetId: "-100123", enabled: true, token: "" }],
              },
            },
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      const stored = readStoredMessengerSettings(db);
      expect(stored.telegram.token).toBe(previous.telegram.token);
      expect(stored.telegram.sessions[0].token).toBe(previous.telegram.sessions[0].token);
    } finally {
      db.close();
    }
  });

  it("PUT /api/settings replaces and clears messenger tokens explicitly", () => {
    const db = setupDb();
    try {
      seedMessengerSettings(
        db,
        encryptMessengerChannelsForStorage({
          telegram: {
            token: "old-root-1111",
            sessions: [{ id: "ops", name: "Ops", targetId: "-100123", enabled: true, token: "old-session-2222" }],
          },
        }),
      );
      const { putHandler } = createHarness(db);

      const replaceRes = createFakeResponse();
      putHandler?.(
        {
          body: {
            messengerChannels: {
              telegram: {
                token: "new-root-3333",
                sessions: [{ id: "ops", name: "Ops", targetId: "-100123", enabled: true, token: "new-session-4444" }],
              },
            },
          },
        },
        replaceRes,
      );
      expect(replaceRes.statusCode).toBe(200);
      const replaced = readStoredMessengerSettings(db);
      expect(replaced.telegram.token).not.toBe("");
      expect(replaced.telegram.sessions[0].token).not.toBe("");

      const clearRes = createFakeResponse();
      putHandler?.(
        {
          body: {
            messengerChannels: {
              telegram: {
                clearToken: true,
                sessions: [{ id: "ops", name: "Ops", targetId: "-100123", enabled: true, clearToken: true }],
              },
            },
          },
        },
        clearRes,
      );

      expect(clearRes.statusCode).toBe(200);
      const cleared = readStoredMessengerSettings(db);
      expect(cleared.telegram.token).toBeUndefined();
      expect(cleared.telegram.sessions[0].token).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("PUT /api/settings rejects token + clearToken and null token updates", () => {
    const db = setupDb();
    try {
      const { putHandler } = createHarness(db);

      const mixedRes = createFakeResponse();
      putHandler?.(
        {
          body: {
            messengerChannels: {
              telegram: {
                token: "abc",
                clearToken: true,
                sessions: [],
              },
            },
          },
        },
        mixedRes,
      );
      expect(mixedRes.statusCode).toBe(400);
      expect(mixedRes.payload).toEqual({ ok: false, error: "invalid_token_update" });

      const nullRes = createFakeResponse();
      putHandler?.(
        {
          body: {
            messengerChannels: {
              telegram: {
                token: null,
                sessions: [],
              },
            },
          },
        },
        nullRes,
      );
      expect(nullRes.statusCode).toBe(400);
      expect(nullRes.payload).toEqual({ ok: false, error: "invalid_token_update" });
    } finally {
      db.close();
    }
  });
});
