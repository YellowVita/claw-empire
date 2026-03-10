import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTaskTerminalRoutes } from "./routes.ts";

function createResponse() {
  return {
    payload: null as unknown,
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

describe("registerTaskTerminalRoutes", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminal read does not auto-create sessions and does not expose interrupt proof", () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-terminal-route-"));
    tempDirs.push(logsDir);
    fs.writeFileSync(path.join(logsDir, "task-1.log"), "hello terminal\n");

    const routes = new Map<string, (req: any, res: any) => unknown>();
    const ensureTaskExecutionSession = vi.fn();
    const db = {
      prepare(sql: string) {
        if (sql.startsWith("SELECT id, kind, message, created_at FROM task_logs WHERE task_id = ?")) {
          return {
            all: () => [{ id: 1, kind: "system", message: "RESUME", created_at: 123 }],
          };
        }
        return {
          all: () => [],
          get: () => undefined,
        };
      },
    };

    registerTaskTerminalRoutes({
      app: {
        get(route: string, handler: (req: any, res: any) => unknown) {
          routes.set(route, handler);
        },
      } as any,
      logsDir,
      hasStructuredJsonLines: () => false,
      db: db as any,
      taskExecutionSessions: new Map([["task-1", { sessionId: "session-existing-1" }]]),
      ensureTaskExecutionSession,
    } as any);

    const handler = routes.get("/api/tasks/:id/terminal");
    expect(handler).toBeTypeOf("function");

    const res = createResponse();
    handler?.(
      {
        params: { id: "task-1" },
        query: { lines: 50, log_limit: 50, pretty: "0" },
      },
      res,
    );

    expect(ensureTaskExecutionSession).not.toHaveBeenCalled();
    expect(res.payload).toMatchObject({
      ok: true,
      exists: true,
      path: path.join(logsDir, "task-1.log"),
      text: "hello terminal\n",
      task_logs: [{ id: 1, kind: "system", message: "RESUME", created_at: 123 }],
    });
    expect((res.payload as Record<string, unknown>).interrupt).toBeUndefined();
  });
});
