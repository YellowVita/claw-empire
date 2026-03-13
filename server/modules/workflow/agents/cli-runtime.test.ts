import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { createCliRuntimeTools } from "./cli-runtime.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      cli_tool_use_id TEXT
    );
  `);
  return db;
}

function createRuntime(
  db: DatabaseSync,
  createSubtaskFromCli: ReturnType<typeof vi.fn>,
  completeSubtaskFromCli: ReturnType<typeof vi.fn>,
) {
  return createCliRuntimeTools({
    db,
    logsDir: "C:/logs",
    buildAgentArgs: vi.fn(),
    clearCliOutputDedup: vi.fn(),
    normalizeStreamChunk: (chunk: Buffer) => chunk.toString("utf8"),
    shouldSkipDuplicateCliOutput: vi.fn(() => false),
    broadcast: vi.fn(),
    TASK_RUN_IDLE_TIMEOUT_MS: 60_000,
    TASK_RUN_HARD_TIMEOUT_MS: 120_000,
    killPidTree: vi.fn(),
    appendTaskLog: vi.fn(),
    activeProcesses: new Map(),
    createSubtaskFromCli,
    completeSubtaskFromCli,
  });
}

describe("createCliRuntimeTools", () => {
  it("does not keep spawn_agent thread mappings when V2 policy skips official foreign-collab subtask creation", () => {
    const db = setupDb();
    try {
      const createSubtaskFromCli = vi.fn(() => ({ created: false }));
      const completeSubtaskFromCli = vi.fn();
      const runtime = createRuntime(db, createSubtaskFromCli, completeSubtaskFromCli);

      runtime.parseAndCreateSubtasks(
        "task-1",
        `${JSON.stringify({
          type: "item.started",
          item: {
            type: "collab_tool_call",
            tool: "spawn_agent",
            id: "item-26",
            prompt: "Task: 개발팀 역할로 API를 구현하세요.",
          },
        })}\n`,
      );

      runtime.parseAndCreateSubtasks(
        "task-1",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "collab_tool_call",
            tool: "spawn_agent",
            id: "item-26",
            receiver_thread_ids: ["thread-dev"],
          },
        })}\n`,
      );

      expect(createSubtaskFromCli).toHaveBeenCalledWith("task-1", "item-26", "개발팀 역할로 API를 구현하세요.", {
        source: "codex_spawn_agent",
      });
      expect(runtime.codexThreadToSubtask.has("thread-dev")).toBe(false);

      runtime.parseAndCreateSubtasks(
        "task-1",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "collab_tool_call",
            tool: "close_agent",
            receiver_thread_ids: ["thread-dev"],
          },
        })}\n`,
      );

      expect(completeSubtaskFromCli).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("revalidates DB-backed spawn_agent subtasks before keeping thread mappings and completes them on close", () => {
    const db = setupDb();
    try {
      const createSubtaskFromCli = vi.fn((taskId: string, toolUseId: string, title: string) => {
        db.prepare("INSERT INTO subtasks (id, task_id, title, status, cli_tool_use_id) VALUES (?, ?, ?, 'in_progress', ?)")
          .run(`sub-${toolUseId}`, taskId, title, toolUseId);
        return { created: true };
      });
      const completeSubtaskFromCli = vi.fn();
      const runtime = createRuntime(db, createSubtaskFromCli, completeSubtaskFromCli);

      runtime.parseAndCreateSubtasks(
        "task-1",
        `${JSON.stringify({
          type: "item.started",
          item: {
            type: "collab_tool_call",
            tool: "spawn_agent",
            id: "item-27",
            prompt: "Task: 디자인팀 역할로 컴포넌트를 정리하세요.",
          },
        })}\n`,
      );

      runtime.parseAndCreateSubtasks(
        "task-1",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "collab_tool_call",
            tool: "spawn_agent",
            id: "item-27",
            receiver_thread_ids: ["thread-design"],
          },
        })}\n`,
      );

      expect(runtime.codexThreadToSubtask.get("thread-design")).toBe("item-27");

      runtime.parseAndCreateSubtasks(
        "task-1",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "collab_tool_call",
            tool: "close_agent",
            receiver_thread_ids: ["thread-design"],
          },
        })}\n`,
      );

      expect(completeSubtaskFromCli).toHaveBeenCalledWith("item-27");
      expect(runtime.codexThreadToSubtask.has("thread-design")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("passes Claude Task tool calls through with the claude_task source tag", () => {
    const db = setupDb();
    try {
      const createSubtaskFromCli = vi.fn(() => ({ created: true }));
      const completeSubtaskFromCli = vi.fn();
      const runtime = createRuntime(db, createSubtaskFromCli, completeSubtaskFromCli);

      runtime.parseAndCreateSubtasks(
        "task-1",
        `${JSON.stringify({
          type: "tool_use",
          tool: "Task",
          id: "claude-1",
          input: {
            description: "디자인팀 역할로 시안을 다듬으세요.",
          },
        })}\n`,
      );

      expect(createSubtaskFromCli).toHaveBeenCalledWith("task-1", "claude-1", "디자인팀 역할로 시안을 다듬으세요.", {
        source: "claude_task",
      });
    } finally {
      db.close();
    }
  });
});
