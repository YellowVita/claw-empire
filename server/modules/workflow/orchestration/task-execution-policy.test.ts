import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TASK_EXECUTION_HOOKS,
  readProjectTaskExecutionHooks,
  resolveTaskExecutionHooksForStage,
  runTaskExecutionHooks,
  type TaskExecutionHooks,
} from "./task-execution-policy.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeWorkflowConfig(
  worktreePath: string,
  value: {
    taskExecutionHooks?: Partial<TaskExecutionHooks> | Record<string, unknown>;
  } | string,
): void {
  const filePath = path.join(worktreePath, ".claw-workflow.json");
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  fs.writeFileSync(filePath, content, "utf8");
}

function createDbWithGlobalHooks(partial: Partial<TaskExecutionHooks> = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const hooks: TaskExecutionHooks = {
    before_run: partial.before_run ?? DEFAULT_TASK_EXECUTION_HOOKS.before_run,
    after_run_success: partial.after_run_success ?? DEFAULT_TASK_EXECUTION_HOOKS.after_run_success,
    after_run_failure: partial.after_run_failure ?? DEFAULT_TASK_EXECUTION_HOOKS.after_run_failure,
  };
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("taskExecutionHooks", JSON.stringify(hooks));
  return db;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("task execution policy project hook overrides", () => {
  it("worktree에 설정 파일이 없으면 null을 반환한다", () => {
    const worktreePath = createTempDir("claw-hooks-none-");
    expect(readProjectTaskExecutionHooks(worktreePath)).toBeNull();
  });

  it("invalid JSON은 warning과 함께 global fallback 대상으로 처리한다", () => {
    const worktreePath = createTempDir("claw-hooks-invalid-json-");
    writeWorkflowConfig(worktreePath, "{ invalid json");

    const config = readProjectTaskExecutionHooks(worktreePath);
    expect(config).toMatchObject({
      valid: false,
      warnings: [".claw-workflow.json parse failed, falling back to global"],
    });
  });

  it("taskExecutionHooks 객체가 없으면 warning과 함께 무시한다", () => {
    const worktreePath = createTempDir("claw-hooks-missing-root-");
    writeWorkflowConfig(worktreePath, { notHooks: true } as any);

    const config = readProjectTaskExecutionHooks(worktreePath);
    expect(config).toMatchObject({
      valid: false,
      warnings: [".claw-workflow.json missing taskExecutionHooks object, falling back to global"],
    });
  });

  it("stage key가 없으면 글로벌을 유지하고 빈 배열은 명시적 override로 처리한다", () => {
    const worktreePath = createTempDir("claw-hooks-stage-presence-");
    writeWorkflowConfig(worktreePath, {
      taskExecutionHooks: {
        before_run: [],
        after_run_success: [
          {
            id: "local-success",
            label: "Local Success",
            command: 'node -e "process.exit(0)"',
          },
        ],
      },
    });

    const config = readProjectTaskExecutionHooks(worktreePath);
    expect(config).toMatchObject({
      valid: true,
      stagePresence: {
        before_run: true,
        after_run_success: true,
        after_run_failure: false,
      },
    });
    expect(config?.hooks.before_run).toEqual([]);
    expect(config?.hooks.after_run_success).toHaveLength(1);
  });

  it("resolveTaskExecutionHooksForStage는 stage key가 없으면 글로벌을 유지한다", () => {
    const db = createDbWithGlobalHooks({
      before_run: [
        {
          id: "global-before",
          label: "Global Before",
          command: 'node -e "process.exit(0)"',
          timeout_ms: 300000,
          continue_on_error: false,
        },
      ],
    });
    const worktreePath = createTempDir("claw-hooks-resolve-global-");
    writeWorkflowConfig(worktreePath, {
      taskExecutionHooks: {
        after_run_success: [
          {
            id: "local-success",
            label: "Local Success",
            command: 'node -e "process.exit(0)"',
          },
        ],
      },
    });

    try {
      const resolved = resolveTaskExecutionHooksForStage(db as any, worktreePath, "before_run");
      expect(resolved.source).toBe("global");
      expect(resolved.hooks).toHaveLength(1);
      expect(resolved.hooks[0]?.id).toBe("global-before");
    } finally {
      db.close();
    }
  });

  it("resolveTaskExecutionHooksForStage는 빈 배열도 stage override로 처리한다", () => {
    const db = createDbWithGlobalHooks({
      before_run: [
        {
          id: "global-before",
          label: "Global Before",
          command: 'node -e "process.exit(0)"',
          timeout_ms: 300000,
          continue_on_error: false,
        },
      ],
    });
    const worktreePath = createTempDir("claw-hooks-resolve-empty-");
    writeWorkflowConfig(worktreePath, {
      taskExecutionHooks: {
        before_run: [],
      },
    });

    try {
      const resolved = resolveTaskExecutionHooksForStage(db as any, worktreePath, "before_run");
      expect(resolved.source).toBe("project");
      expect(resolved.hooks).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("runTaskExecutionHooks는 로컬 before_run override를 실행하고 글로벌 훅을 건너뛴다", async () => {
    const db = createDbWithGlobalHooks({
      before_run: [
        {
          id: "global-before",
          label: "Global Before",
          command: 'node -e "console.log(\'GLOBAL\')"',
          timeout_ms: 300000,
          continue_on_error: false,
        },
      ],
    });
    const worktreePath = createTempDir("claw-hooks-run-local-");
    writeWorkflowConfig(worktreePath, {
      taskExecutionHooks: {
        before_run: [
          {
            id: "local-before",
            label: "Local Before",
            command: 'node -e "console.log(\'LOCAL\')"',
          },
        ],
      },
    });
    const logLines: string[] = [];

    try {
      const result = await runTaskExecutionHooks({
        db: db as any,
        stage: "before_run",
        taskId: "task-1",
        taskTitle: "Task One",
        projectPath: worktreePath,
        worktreePath,
        agentId: "agent-1",
        provider: "claude",
        appendTaskLog: (_taskId, _kind, message) => {
          logLines.push(message);
        },
      });

      expect(result).toEqual({ ok: true });
      expect(logLines.some((line) => line.includes("Local Before"))).toBe(true);
      expect(logLines.some((line) => line.includes("Global Before"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("invalid local hook schema는 warning 후 글로벌 훅으로 fallback 한다", async () => {
    const db = createDbWithGlobalHooks({
      before_run: [
        {
          id: "global-before",
          label: "Global Before",
          command: 'node -e "console.log(\'GLOBAL_FALLBACK\')"',
          timeout_ms: 300000,
          continue_on_error: false,
        },
      ],
    });
    const worktreePath = createTempDir("claw-hooks-invalid-schema-");
    writeWorkflowConfig(worktreePath, {
      taskExecutionHooks: {
        before_run: [{}],
      },
    });
    const logLines: string[] = [];

    try {
      const result = await runTaskExecutionHooks({
        db: db as any,
        stage: "before_run",
        taskId: "task-2",
        taskTitle: "Task Two",
        projectPath: worktreePath,
        worktreePath,
        agentId: "agent-1",
        provider: "claude",
        appendTaskLog: (_taskId, _kind, message) => {
          logLines.push(message);
        },
      });

      expect(result).toEqual({ ok: true });
      expect(logLines).toContain(".claw-workflow.json invalid hook schema, falling back to global");
      expect(logLines.some((line) => line.includes("Global Before"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("로컬 before_run 실패는 blocking 된다", async () => {
    const db = createDbWithGlobalHooks();
    const worktreePath = createTempDir("claw-hooks-blocking-");
    writeWorkflowConfig(worktreePath, {
      taskExecutionHooks: {
        before_run: [
          {
            id: "local-block",
            label: "Local Blocking Hook",
            command: 'node -e "process.exit(2)"',
            continue_on_error: false,
          },
        ],
      },
    });
    const logLines: string[] = [];

    try {
      const result = await runTaskExecutionHooks({
        db: db as any,
        stage: "before_run",
        taskId: "task-3",
        taskTitle: "Task Three",
        projectPath: worktreePath,
        worktreePath,
        agentId: "agent-1",
        provider: "claude",
        appendTaskLog: (_taskId, _kind, message) => {
          logLines.push(message);
        },
      });

      expect(result.ok).toBe(false);
      expect(result.failedHookId).toBe("local-block");
      expect(logLines.some((line) => line.includes("Task hook failed [before_run] Local Blocking Hook"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("로컬 after_run_failure 실패는 warning-only로 남고 완료 semantics는 유지한다", async () => {
    const db = createDbWithGlobalHooks();
    const worktreePath = createTempDir("claw-hooks-after-failure-");
    writeWorkflowConfig(worktreePath, {
      taskExecutionHooks: {
        after_run_failure: [
          {
            id: "local-after-failure",
            label: "Local After Failure",
            command: 'node -e "process.exit(3)"',
            continue_on_error: false,
          },
        ],
      },
    });
    const logLines: string[] = [];

    try {
      const result = await runTaskExecutionHooks({
        db: db as any,
        stage: "after_run_failure",
        taskId: "task-4",
        taskTitle: "Task Four",
        projectPath: worktreePath,
        worktreePath,
        agentId: "agent-1",
        provider: "claude",
        appendTaskLog: (_taskId, _kind, message) => {
          logLines.push(message);
        },
      });

      expect(result).toEqual({ ok: true });
      expect(logLines.some((line) => line.includes("Task hook failed [after_run_failure] Local After Failure"))).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });
});
