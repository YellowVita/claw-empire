import { exec } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { recordTaskExecutionEvent } from "./task-execution-events.ts";
import { describeProjectWorkflowConfigSource, readProjectWorkflowConfig, readProjectWorkflowConfigCached } from "../packs/project-config.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

export const TASK_EXECUTION_POLICY_SETTING_KEY = "taskExecutionPolicy";
export const TASK_EXECUTION_HOOKS_SETTING_KEY = "taskExecutionHooks";

export type TaskRetryReason =
  | "idle_timeout"
  | "hard_timeout"
  | "orphan_recovery"
  | "integration_validation_failed";
export type TaskHookStage = "before_run" | "after_run_success" | "after_run_failure";

export type TaskExecutionPolicy = {
  enabled: boolean;
  max_auto_retries: number;
  base_backoff_ms: number;
  max_backoff_ms: number;
  jitter_ratio: number;
  retry_on: TaskRetryReason[];
  queue_sweep_ms: number;
};

export type TaskExecutionHook = {
  id: string;
  label: string;
  command: string;
  timeout_ms: number;
  continue_on_error: boolean;
};

export type TaskExecutionHooks = Record<TaskHookStage, TaskExecutionHook[]>;
export type TaskExecutionHookStagePresence = Record<TaskHookStage, boolean>;

export type ProjectTaskExecutionHooksConfig = {
  hooks: TaskExecutionHooks;
  stagePresence: TaskExecutionHookStagePresence;
  warnings: string[];
  valid: boolean;
};

export type TaskRetryQueueRow = {
  task_id: string;
  attempt_count: number;
  next_run_at: number;
  last_reason: string | null;
  created_at: number;
  updated_at: number;
};

export const DEFAULT_TASK_EXECUTION_POLICY: TaskExecutionPolicy = {
  enabled: true,
  max_auto_retries: 3,
  base_backoff_ms: 10_000,
  max_backoff_ms: 300_000,
  jitter_ratio: 0.15,
  retry_on: ["idle_timeout", "hard_timeout", "orphan_recovery", "integration_validation_failed"],
  queue_sweep_ms: 5_000,
};

export const DEFAULT_TASK_EXECUTION_HOOKS: TaskExecutionHooks = {
  before_run: [],
  after_run_success: [],
  after_run_failure: [],
};

const EMPTY_TASK_EXECUTION_HOOK_STAGE_PRESENCE: TaskExecutionHookStagePresence = {
  before_run: false,
  after_run_success: false,
  after_run_failure: false,
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSettingsJson(db: DbLike, key: string): unknown {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key) as
      | { value?: unknown }
      | undefined;
    if (!row) return null;
    if (typeof row.value !== "string") return row.value ?? null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed);
}

function normalizeRetryReasonList(value: unknown, fallback: TaskRetryReason[]): TaskRetryReason[] {
  const allowed = new Set<TaskRetryReason>([
    "idle_timeout",
    "hard_timeout",
    "orphan_recovery",
    "integration_validation_failed",
  ]);
  if (!Array.isArray(value)) return [...fallback];
  const next = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is TaskRetryReason => allowed.has(item as TaskRetryReason));
  return next.length > 0 ? next : [...fallback];
}

function normalizeHookStageHooks(value: unknown): TaskExecutionHook[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const raw = asObject(entry);
      if (!raw) return null;
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `hook-${index + 1}`;
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id;
      const command = typeof raw.command === "string" ? raw.command.trim() : "";
      if (!command) return null;
      return {
        id,
        label,
        command,
        timeout_ms: toPositiveInt(raw.timeout_ms, 300_000),
        continue_on_error: raw.continue_on_error === true,
      } satisfies TaskExecutionHook;
    })
    .filter((item): item is TaskExecutionHook => Boolean(item));
}

function isValidHookStageHookArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    const raw = asObject(entry);
    return Boolean(raw && typeof raw.command === "string" && raw.command.trim());
  });
}

export function normalizeTaskExecutionPolicyValue(value: unknown): TaskExecutionPolicy {
  const raw = asObject(value) ?? {};
  const jitterRaw = Number(raw.jitter_ratio);
  const jitterRatio = Number.isFinite(jitterRaw) ? jitterRaw : DEFAULT_TASK_EXECUTION_POLICY.jitter_ratio;
  return {
    enabled: raw.enabled !== false,
    max_auto_retries: Math.min(10, Math.max(1, toPositiveInt(raw.max_auto_retries, DEFAULT_TASK_EXECUTION_POLICY.max_auto_retries))),
    base_backoff_ms: Math.max(1_000, toPositiveInt(raw.base_backoff_ms, DEFAULT_TASK_EXECUTION_POLICY.base_backoff_ms)),
    max_backoff_ms: Math.max(1_000, toPositiveInt(raw.max_backoff_ms, DEFAULT_TASK_EXECUTION_POLICY.max_backoff_ms)),
    jitter_ratio: Math.max(0, Math.min(1, jitterRatio)),
    retry_on: normalizeRetryReasonList(raw.retry_on, DEFAULT_TASK_EXECUTION_POLICY.retry_on),
    queue_sweep_ms: Math.max(1_000, toPositiveInt(raw.queue_sweep_ms, DEFAULT_TASK_EXECUTION_POLICY.queue_sweep_ms)),
  };
}

export function normalizeTaskExecutionHooksValue(value: unknown): TaskExecutionHooks {
  const raw = asObject(value) ?? {};
  return {
    before_run: normalizeHookStageHooks(raw.before_run),
    after_run_success: normalizeHookStageHooks(raw.after_run_success),
    after_run_failure: normalizeHookStageHooks(raw.after_run_failure),
  };
}

export function readTaskExecutionPolicy(db: DbLike): TaskExecutionPolicy {
  return normalizeTaskExecutionPolicyValue(readSettingsJson(db, TASK_EXECUTION_POLICY_SETTING_KEY));
}

export function readTaskExecutionHooks(db: DbLike): TaskExecutionHooks {
  return normalizeTaskExecutionHooksValue(readSettingsJson(db, TASK_EXECUTION_HOOKS_SETTING_KEY));
}

export function readProjectTaskExecutionHooks(worktreePath: string): ProjectTaskExecutionHooksConfig | null {
  const config = readProjectWorkflowConfig(worktreePath);
  if (!config) return null;
  if (!config.raw) {
    return {
      hooks: DEFAULT_TASK_EXECUTION_HOOKS,
      stagePresence: { ...EMPTY_TASK_EXECUTION_HOOK_STAGE_PRESENCE },
      warnings: [...config.warnings],
      valid: false,
    };
  }

  const sourceLabel = describeProjectWorkflowConfigSource(config);
  const taskExecutionHooksValue = config.raw.taskExecutionHooks;
  const rawHooks = asObject(taskExecutionHooksValue);
  if (!rawHooks) {
    return {
      hooks: DEFAULT_TASK_EXECUTION_HOOKS,
      stagePresence: { ...EMPTY_TASK_EXECUTION_HOOK_STAGE_PRESENCE },
      warnings: [`${sourceLabel} missing taskExecutionHooks object, falling back to global`],
      valid: false,
    };
  }

  const stagePresence: TaskExecutionHookStagePresence = {
    before_run: Object.prototype.hasOwnProperty.call(rawHooks, "before_run"),
    after_run_success: Object.prototype.hasOwnProperty.call(rawHooks, "after_run_success"),
    after_run_failure: Object.prototype.hasOwnProperty.call(rawHooks, "after_run_failure"),
  };

  const invalidStageSchema = (Object.keys(stagePresence) as TaskHookStage[]).some(
    (stage) => stagePresence[stage] && !isValidHookStageHookArray(rawHooks[stage]),
  );
  if (invalidStageSchema) {
    return {
      hooks: DEFAULT_TASK_EXECUTION_HOOKS,
      stagePresence: { ...EMPTY_TASK_EXECUTION_HOOK_STAGE_PRESENCE },
      warnings: [`${sourceLabel} invalid hook schema, falling back to global`],
      valid: false,
    };
  }

  return {
    hooks: normalizeTaskExecutionHooksValue(rawHooks),
    stagePresence,
    warnings: [...config.warnings],
    valid: true,
  };
}

export function readProjectTaskExecutionHooksCached(db: DbLike, worktreePath: string): ProjectTaskExecutionHooksConfig | null {
  const config = readProjectWorkflowConfigCached(db, worktreePath);
  if (!config) return null;
  if (!config.raw) {
    return {
      hooks: DEFAULT_TASK_EXECUTION_HOOKS,
      stagePresence: { ...EMPTY_TASK_EXECUTION_HOOK_STAGE_PRESENCE },
      warnings: [...config.warnings],
      valid: false,
    };
  }

  const sourceLabel = describeProjectWorkflowConfigSource(config);
  const taskExecutionHooksValue = config.raw.taskExecutionHooks;
  const rawHooks = asObject(taskExecutionHooksValue);
  if (!rawHooks) {
    return {
      hooks: DEFAULT_TASK_EXECUTION_HOOKS,
      stagePresence: { ...EMPTY_TASK_EXECUTION_HOOK_STAGE_PRESENCE },
      warnings: [`${sourceLabel} missing taskExecutionHooks object, falling back to global`],
      valid: false,
    };
  }

  const stagePresence: TaskExecutionHookStagePresence = {
    before_run: Object.prototype.hasOwnProperty.call(rawHooks, "before_run"),
    after_run_success: Object.prototype.hasOwnProperty.call(rawHooks, "after_run_success"),
    after_run_failure: Object.prototype.hasOwnProperty.call(rawHooks, "after_run_failure"),
  };

  const invalidStageSchema = (Object.keys(stagePresence) as TaskHookStage[]).some(
    (stage) => stagePresence[stage] && !isValidHookStageHookArray(rawHooks[stage]),
  );
  if (invalidStageSchema) {
    return {
      hooks: DEFAULT_TASK_EXECUTION_HOOKS,
      stagePresence: { ...EMPTY_TASK_EXECUTION_HOOK_STAGE_PRESENCE },
      warnings: [`${sourceLabel} invalid hook schema, falling back to global`],
      valid: false,
    };
  }

  return {
    hooks: normalizeTaskExecutionHooksValue(rawHooks),
    stagePresence,
    warnings: [...config.warnings],
    valid: true,
  };
}

export function resolveTaskExecutionHooksForStage(
  db: DbLike,
  worktreePath: string,
  stage: TaskHookStage,
): { hooks: TaskExecutionHook[]; warnings: string[]; source: "global" | "project" } {
  const globalHooks = readTaskExecutionHooks(db);
  const localConfig = readProjectTaskExecutionHooksCached(db, worktreePath);
  if (!localConfig) {
    return { hooks: globalHooks[stage], warnings: [], source: "global" };
  }
  if (!localConfig.valid) {
    return { hooks: globalHooks[stage], warnings: localConfig.warnings, source: "global" };
  }
  if (localConfig.stagePresence[stage]) {
    return { hooks: localConfig.hooks[stage], warnings: localConfig.warnings, source: "project" };
  }
  return { hooks: globalHooks[stage], warnings: localConfig.warnings, source: "global" };
}

export function shouldRetryForReason(policy: TaskExecutionPolicy, reason: TaskRetryReason): boolean {
  return Boolean(policy.enabled && policy.retry_on.includes(reason));
}

export function getMaxAutoRetriesForReason(policy: TaskExecutionPolicy, reason: TaskRetryReason): number {
  if (reason === "integration_validation_failed") {
    return Math.min(policy.max_auto_retries, 2);
  }
  return policy.max_auto_retries;
}

export function computeRetryDelayMs(policy: TaskExecutionPolicy, attemptCount: number): number {
  const base = Math.min(policy.base_backoff_ms * 2 ** Math.max(0, attemptCount - 1), policy.max_backoff_ms);
  const jitterWindow = Math.round(base * policy.jitter_ratio);
  if (jitterWindow <= 0) return base;
  const delta = Math.floor(Math.random() * (jitterWindow * 2 + 1)) - jitterWindow;
  return Math.max(1_000, base + delta);
}

export function readTaskRetryQueueRow(db: DbLike, taskId: string): TaskRetryQueueRow | undefined {
  try {
    return db.prepare("SELECT * FROM task_retry_queue WHERE task_id = ?").get(taskId) as TaskRetryQueueRow | undefined;
  } catch {
    return undefined;
  }
}

export function upsertTaskRetryQueueRow(
  db: DbLike,
  row: Pick<TaskRetryQueueRow, "task_id" | "attempt_count" | "next_run_at" | "last_reason" | "created_at" | "updated_at">,
): void {
  try {
    db.prepare(
      `
        INSERT INTO task_retry_queue (task_id, attempt_count, next_run_at, last_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          attempt_count = excluded.attempt_count,
          next_run_at = excluded.next_run_at,
          last_reason = excluded.last_reason,
          updated_at = excluded.updated_at
      `,
    ).run(row.task_id, row.attempt_count, row.next_run_at, row.last_reason, row.created_at, row.updated_at);
  } catch {
    // Legacy test harnesses may not define this table yet.
  }
}

export function deleteTaskRetryQueueRow(db: DbLike, taskId: string): void {
  try {
    db.prepare("DELETE FROM task_retry_queue WHERE task_id = ?").run(taskId);
  } catch {
    // ignore missing table in legacy harnesses
  }
}

export function listDueTaskRetryQueueRows(db: DbLike, now: number, limit = 20): TaskRetryQueueRow[] {
  try {
    return db
      .prepare("SELECT * FROM task_retry_queue WHERE next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?")
      .all(now, limit) as TaskRetryQueueRow[];
  } catch {
    return [];
  }
}

export function rescheduleBusyTaskRetryQueueRow(db: DbLike, taskId: string, now: number, delayMs = 30_000): void {
  try {
    db.prepare("UPDATE task_retry_queue SET next_run_at = ?, updated_at = ? WHERE task_id = ?").run(
      now + delayMs,
      now,
      taskId,
    );
  } catch {
    // ignore missing table in legacy harnesses
  }
}

type RunTaskExecutionHooksParams = {
  db: DbLike;
  stage: TaskHookStage;
  taskId: string;
  taskTitle: string;
  projectPath: string;
  worktreePath: string;
  agentId: string;
  provider: string;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
};

type RunTaskExecutionHooksResult = {
  ok: boolean;
  failedHookId?: string;
  error?: string;
};

function buildHookEnv(params: Omit<RunTaskExecutionHooksParams, "db" | "stage" | "appendTaskLog">): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAW_TASK_ID: params.taskId,
    CLAW_TASK_TITLE: params.taskTitle,
    CLAW_PROJECT_PATH: params.projectPath,
    CLAW_WORKTREE_PATH: params.worktreePath,
    CLAW_AGENT_ID: params.agentId,
    CLAW_PROVIDER: params.provider,
  };
}

function runCommandHook(
  hook: TaskExecutionHook,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = exec(hook.command, {
      cwd,
      env,
      timeout: hook.timeout_ms,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const timedOut = Boolean(error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed);
      const errorCode = (error as NodeJS.ErrnoException & { code?: unknown })?.code;
      const code =
        typeof errorCode === "number"
          ? errorCode
          : error
            ? 1
            : 0;
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });

    child.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message, timedOut: false });
    });
  });
}

export async function runTaskExecutionHooks(params: RunTaskExecutionHooksParams): Promise<RunTaskExecutionHooksResult> {
  const resolved = resolveTaskExecutionHooksForStage(params.db, params.worktreePath, params.stage);
  for (const warning of resolved.warnings) {
    params.appendTaskLog(params.taskId, "system", warning);
    recordTaskExecutionEvent(params.db, {
      taskId: params.taskId,
      category: "hook",
      action: "config_fallback",
      status: "warning",
      message: warning,
      hookSource: "global",
      details: {
        stage: params.stage,
        provider: params.provider,
        project_path: params.projectPath,
        worktree_path: params.worktreePath,
      },
    });
  }
  const hooks = resolved.hooks;
  if (hooks.length <= 0) return { ok: true };

  const env = buildHookEnv(params);
  for (const hook of hooks) {
    params.appendTaskLog(params.taskId, "system", `Task hook start [${params.stage}] ${hook.label} (${hook.id})`);
    const startedAt = Date.now();
    const result = await runCommandHook(hook, params.worktreePath, env);
    const durationMs = Math.max(0, Date.now() - startedAt);
    const detail = [
      `code=${result.code}`,
      result.timedOut ? "timed_out=yes" : "",
      result.stdout ? `stdout=${JSON.stringify(result.stdout.slice(0, 400))}` : "",
      result.stderr ? `stderr=${JSON.stringify(result.stderr.slice(0, 400))}` : "",
    ]
      .filter(Boolean)
      .join(", ");

    if (result.code === 0) {
      params.appendTaskLog(params.taskId, "system", `Task hook done [${params.stage}] ${hook.label} (${detail || "ok"})`);
      recordTaskExecutionEvent(params.db, {
        taskId: params.taskId,
        category: "hook",
        action: "success",
        status: "success",
        message: `Task hook done [${params.stage}] ${hook.label} (${detail || "ok"})`,
        hookSource: resolved.source,
        durationMs,
        details: {
          stage: params.stage,
          hook_id: hook.id,
          hook_label: hook.label,
          provider: params.provider,
          continue_on_error: hook.continue_on_error,
          timed_out: result.timedOut,
          code: result.code,
        },
      });
      continue;
    }

    const message = `Task hook failed [${params.stage}] ${hook.label} (${detail || "code=1"})`;
    const isBlocking = params.stage === "before_run" && !hook.continue_on_error;
    const kind = isBlocking ? "error" : "system";
    params.appendTaskLog(params.taskId, kind, message);
    recordTaskExecutionEvent(params.db, {
      taskId: params.taskId,
      category: "hook",
      action: "failure",
      status: "failure",
      message,
      hookSource: resolved.source,
      durationMs,
      details: {
        stage: params.stage,
        hook_id: hook.id,
        hook_label: hook.label,
        provider: params.provider,
        continue_on_error: hook.continue_on_error,
        timed_out: result.timedOut,
        code: result.code,
      },
    });

    if (isBlocking) {
      return { ok: false, failedHookId: hook.id, error: message };
    }
  }

  return { ok: true };
}
