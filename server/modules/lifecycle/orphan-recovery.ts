import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import { getAgentById, setAgentIdleAndClearTask } from "../../db/queries/agent-queries.ts";
import {
  getLatestRunLog,
  getRecentTaskLog,
  getTaskById,
  listInProgressTasks,
  setTaskInboxIfInProgress,
  setTaskStatus,
} from "../../db/queries/task-queries.ts";
import {
  computeRetryDelayMs,
  deleteTaskRetryQueueRow,
  readTaskExecutionPolicy,
  readTaskRetryQueueRow,
  shouldRetryForReason,
  upsertTaskRetryQueueRow,
} from "../workflow/orchestration/task-execution-policy.ts";
import { recordTaskExecutionEvent } from "../workflow/orchestration/task-execution-events.ts";

export type InProgressRecoveryReason = "startup" | "interval";

export interface OrphanRecoveryDeps {
  db: DatabaseSync;
  activeProcesses: Map<string, { pid?: number }>;
  IN_PROGRESS_ORPHAN_GRACE_MS: number;
  logsDir: string;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  broadcast: (type: string, payload: unknown) => void;
  clearTaskWorkflowState: (taskId: string) => void;
  endTaskExecutionSession: (taskId: string, reason: string) => void;
  handleTaskRunComplete: (taskId: string, exitCode: number) => void;
  isPidAlive: (pid: number) => boolean;
  notifyCeo: (message: string, taskId?: string) => void;
  nowMs: () => number;
  resolveLang: (text: string) => "ko" | "en" | "ja" | "zh";
  stopProgressTimer: (taskId: string) => void;
  notifyTaskStatus: (taskId: string, title: string, status: string, lang: string) => void;
}

const ORPHAN_RECENT_ACTIVITY_WINDOW_FLOOR_MS = 120_000;

function enqueueOrphanRetry(
  deps: Pick<OrphanRecoveryDeps, "db" | "appendTaskLog" | "nowMs">,
  task: { id: string; title: string; updated_at: number | null },
): boolean {
  const { db, appendTaskLog, nowMs } = deps;
  const policy = readTaskExecutionPolicy(db as any);
  if (!shouldRetryForReason(policy, "orphan_recovery")) return false;

  const existingRow = readTaskRetryQueueRow(db as any, task.id);
  const attemptCount = (existingRow?.attempt_count ?? 0) + 1;
  const now = nowMs();
  if (attemptCount > policy.max_auto_retries) {
    deleteTaskRetryQueueRow(db as any, task.id);
    setTaskStatus(db, task.id, "inbox", now);
    appendTaskLog(
      task.id,
      "system",
      `Recovery watchdog exhausted orphan retries (max=${policy.max_auto_retries}) -> inbox`,
    );
    recordTaskExecutionEvent(db as any, {
      taskId: task.id,
      category: "retry",
      action: "exhausted",
      status: "warning",
      message: `Recovery watchdog exhausted orphan retries (max=${policy.max_auto_retries}) -> inbox`,
      attemptCount,
      details: { reason: "orphan_recovery", max_auto_retries: policy.max_auto_retries },
      createdAt: now,
    });
    return false;
  }

  const delayMs = computeRetryDelayMs(policy, attemptCount);
  upsertTaskRetryQueueRow(db as any, {
    task_id: task.id,
    attempt_count: attemptCount,
    next_run_at: now + delayMs,
    last_reason: "orphan_recovery",
    created_at: existingRow?.created_at ?? now,
    updated_at: now,
  });
  setTaskStatus(db, task.id, "pending", now);
  appendTaskLog(
    task.id,
    "system",
    `Recovery watchdog queued automatic retry (reason=orphan_recovery, attempt=${attemptCount}, delay_ms=${delayMs})`,
  );
  recordTaskExecutionEvent(db as any, {
    taskId: task.id,
    category: "retry",
    action: "queued",
    status: "warning",
    message: `Recovery watchdog queued automatic retry (reason=orphan_recovery, attempt=${attemptCount}, delay_ms=${delayMs})`,
    attemptCount,
    details: { reason: "orphan_recovery", delay_ms: delayMs },
    createdAt: now,
  });
  return true;
}

export function recoverOrphanInProgressTasks({
  db,
  activeProcesses,
  IN_PROGRESS_ORPHAN_GRACE_MS,
  logsDir,
  appendTaskLog,
  broadcast,
  clearTaskWorkflowState,
  endTaskExecutionSession,
  handleTaskRunComplete,
  isPidAlive,
  notifyCeo,
  nowMs,
  resolveLang,
  stopProgressTimer,
  notifyTaskStatus,
}: OrphanRecoveryDeps,
reason: InProgressRecoveryReason): void {
  const now = nowMs();
  const recentActivityWindowMs = Math.max(ORPHAN_RECENT_ACTIVITY_WINDOW_FLOOR_MS, IN_PROGRESS_ORPHAN_GRACE_MS);

  for (const task of listInProgressTasks(db)) {
    const active = activeProcesses.get(task.id);
    if (active) {
      const pid = typeof active.pid === "number" ? active.pid : null;
      if (pid !== null && pid > 0 && !isPidAlive(pid)) {
        activeProcesses.delete(task.id);
        appendTaskLog(task.id, "system", `Recovery (${reason}): removed stale process handle (pid=${pid})`);
        recordTaskExecutionEvent(db as any, {
          taskId: task.id,
          category: "watchdog",
          action: "stale_process_cleared",
          status: "warning",
          message: `Recovery (${reason}): removed stale process handle (pid=${pid})`,
          details: { recovery_reason: reason, pid },
          createdAt: now,
        });
      } else {
        continue;
      }
    }

    const lastTouchedAt = Math.max(task.updated_at ?? 0, task.started_at ?? 0, task.created_at ?? 0);
    const ageMs = lastTouchedAt > 0 ? Math.max(0, now - lastTouchedAt) : IN_PROGRESS_ORPHAN_GRACE_MS + 1;
    if (ageMs < IN_PROGRESS_ORPHAN_GRACE_MS) continue;

    if (getRecentTaskLog(db, task.id, now - recentActivityWindowMs)) {
      continue;
    }

    try {
      const logPath = path.join(logsDir, `${task.id}.log`);
      const stat = fs.statSync(logPath);
      const logIdleMs = Math.max(0, now - Math.floor(stat.mtimeMs || 0));
      if (logIdleMs <= recentActivityWindowMs) {
        continue;
      }
    } catch {
      // ignore
    }

    const latestRunMessage = getLatestRunLog(db, task.id)?.message ?? "";
    if (latestRunMessage.startsWith("RUN completed (exit code: 0)")) {
      appendTaskLog(
        task.id,
        "system",
        `Recovery (${reason}): orphan in_progress detected (age_ms=${ageMs}) → replaying successful completion`,
      );
      handleTaskRunComplete(task.id, 0);
      continue;
    }

    if (latestRunMessage.startsWith("RUN ") || latestRunMessage.startsWith("Agent spawn failed:")) {
      appendTaskLog(
        task.id,
        "system",
        `Recovery (${reason}): orphan in_progress detected (age_ms=${ageMs}) → replaying failed completion`,
      );
      handleTaskRunComplete(task.id, 1);
      continue;
    }

    const retried = enqueueOrphanRetry({ db, appendTaskLog, nowMs }, task);
    recordTaskExecutionEvent(db as any, {
      taskId: task.id,
      category: "watchdog",
      action: "orphan_recovery_decision",
      status: retried ? "warning" : "failure",
      message: `Recovery (${reason}): in_progress without active process/run log (age_ms=${ageMs}) -> ${retried ? "pending/retry" : "inbox"}`,
      details: { recovery_reason: reason, age_ms: ageMs, outcome: retried ? "pending_retry" : "inbox" },
      createdAt: now,
    });
    if (!retried) {
      const moved = setTaskInboxIfInProgress(db, task.id, nowMs());
      if (moved === 0) continue;
    }

    stopProgressTimer(task.id);
    clearTaskWorkflowState(task.id);
    endTaskExecutionSession(task.id, `orphan_in_progress_${reason}`);
    appendTaskLog(
      task.id,
      "system",
      `Recovery (${reason}): in_progress without active process/run log (age_ms=${ageMs}) -> ${retried ? "pending/retry" : "inbox"}`,
    );

    if (task.assigned_agent_id) {
      setAgentIdleAndClearTask(db, task.assigned_agent_id);
      broadcast("agent_status", getAgentById(db, task.assigned_agent_id));
    }

    broadcast("task_update", getTaskById(db, task.id));
    const lang = resolveLang(task.title);
    notifyTaskStatus(task.id, task.title, retried ? "pending" : "inbox", lang);
    const watchdogMessage =
      retried
        ? lang === "en"
          ? `[WATCHDOG] '${task.title}' lost its active process and was queued for automatic retry.`
          : lang === "ja"
            ? `[WATCHDOG] '${task.title}' は実行プロセスを失ったため、自動再試行キューに入れました。`
            : lang === "zh"
              ? `[WATCHDOG] '${task.title}' 丢失了执行进程，已加入自动重试队列。`
              : `[WATCHDOG] '${task.title}' 작업이 실행 프로세스를 잃어 자동 재시도 대기열에 넣었습니다.`
        : lang === "en"
          ? `[WATCHDOG] '${task.title}' was in progress but had no active process. Recovered to inbox.`
          : lang === "ja"
            ? `[WATCHDOG] '${task.title}' は in_progress でしたが実行プロセスが存在しないため inbox に復旧しました。`
            : lang === "zh"
              ? `[WATCHDOG] '${task.title}' 处于 in_progress，但未发现执行进程，已恢复到 inbox。`
              : `[WATCHDOG] '${task.title}' 작업이 in_progress 상태였지만 실행 프로세스가 없어 inbox로 복구했습니다.`;
    notifyCeo(watchdogMessage, task.id);
  }
}
