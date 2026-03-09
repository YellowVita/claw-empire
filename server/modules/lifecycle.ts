import type { RuntimeContext } from "../types/runtime-context.ts";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import type { WebSocket as WsSocket } from "ws";
import fs from "node:fs";
import path from "path";
import { execFileSync } from "node:child_process";
import { HOST, PKG_VERSION, PORT } from "../config/runtime.ts";
import { notifyTaskStatus } from "../gateway/client.ts";
import { startDiscordReceiver } from "../messenger/discord-receiver.ts";
import { startTelegramReceiver } from "../messenger/telegram-receiver.ts";
import { registerGracefulShutdownHandlers } from "./lifecycle/register-graceful-shutdown.ts";
import { filterStartupReviewRecoveryRows } from "./lifecycle/review-recovery.ts";
import {
  buildManagedWorktreeBranchName,
  guardManagedWorktreePath,
  parseManagedWorktreeDirName,
} from "./workflow/core/worktree/lifecycle.ts";
import {
  computeRetryDelayMs,
  deleteTaskRetryQueueRow,
  listDueTaskRetryQueueRows,
  readTaskExecutionPolicy,
  readTaskRetryQueueRow,
  rescheduleBusyTaskRetryQueueRow,
  shouldRetryForReason,
  upsertTaskRetryQueueRow,
} from "./workflow/orchestration/task-execution-policy.ts";
import { recordTaskExecutionEvent } from "./workflow/orchestration/task-execution-events.ts";

type DbPrepareLike = Pick<DatabaseSync, "prepare">;

type StartupOrphanWorktreeCleanupSummary = {
  scannedProjects: number;
  candidateCount: number;
  pruneSuccessCount: number;
  pruneFailureCount: number;
  cleanedCount: number;
  deferredCount: number;
  deferredReasons: Record<string, number>;
};

type StartupOrphanWorktreeCleanupDeps = {
  db: DbPrepareLike;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  runGit?: (cwd: string, args: string[]) => void;
};

const STARTUP_WORKTREE_CLEANUP_PREFIX = "startup_orphan_worktree_cleanup";
const STARTUP_WORKTREE_AUTOCLEAN_STATUSES = new Set(["done", "cancelled"]);
const STARTUP_WORKTREE_DEFER_STATUSES = new Set([
  "inbox",
  "planned",
  "collaborating",
  "in_progress",
  "review",
  "pending",
]);

function incrementReason(summary: StartupOrphanWorktreeCleanupSummary, reason: string): void {
  summary.deferredCount += 1;
  summary.deferredReasons[reason] = (summary.deferredReasons[reason] ?? 0) + 1;
}

export function cleanupStartupOrphanWorktrees(
  deps: StartupOrphanWorktreeCleanupDeps,
): StartupOrphanWorktreeCleanupSummary {
  const {
    db,
    log = (message: string) => console.log(message),
    warn = (message: string) => console.warn(message),
    runGit = (cwd: string, args: string[]) => {
      execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
    },
  } = deps;

  const summary: StartupOrphanWorktreeCleanupSummary = {
    scannedProjects: 0,
    candidateCount: 0,
    pruneSuccessCount: 0,
    pruneFailureCount: 0,
    cleanedCount: 0,
    deferredCount: 0,
    deferredReasons: {},
  };

  const projectPaths = db
    .prepare(
      `
        SELECT DISTINCT project_path
        FROM (
          SELECT project_path FROM projects
          UNION
          SELECT project_path FROM tasks
        )
        WHERE TRIM(COALESCE(project_path, '')) != ''
      `,
    )
    .all() as Array<{ project_path: string }>;
  const taskLookup = db.prepare(
    `
      SELECT id, status
      FROM tasks
      WHERE substr(id, 1, 8) = ?
    `,
  );

  for (const row of projectPaths) {
    const projectPath = row.project_path;
    summary.scannedProjects += 1;

    const rootGuard = guardManagedWorktreePath(projectPath);
    if (!rootGuard.ok) {
      incrementReason(summary, "project_guard_failed");
      warn(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} project deferred (${projectPath}): ${rootGuard.reason}`);
      continue;
    }

    const worktreeRoot = rootGuard.worktreeRootPath;
    if (!fs.existsSync(worktreeRoot)) {
      continue;
    }

    try {
      runGit(projectPath, ["worktree", "prune"]);
      summary.pruneSuccessCount += 1;
    } catch (error) {
      summary.pruneFailureCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      warn(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} prune failed (${projectPath}): ${message}`);
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(worktreeRoot, { withFileTypes: true });
    } catch (error) {
      incrementReason(summary, "readdir_failed");
      const message = error instanceof Error ? error.message : String(error);
      warn(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} scan failed (${worktreeRoot}): ${message}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      summary.candidateCount += 1;

      const parsed = parseManagedWorktreeDirName(entry.name);
      if (!parsed) {
        incrementReason(summary, "invalid_dir_name");
        warn(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} deferred (${entry.name}): invalid_dir_name`);
        continue;
      }

      const candidatePath = path.join(worktreeRoot, entry.name);
      const targetGuard = guardManagedWorktreePath(projectPath, candidatePath);
      if (!targetGuard.ok) {
        incrementReason(summary, "target_guard_failed");
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} deferred (${candidatePath}): ${targetGuard.reason}`,
        );
        continue;
      }

      const matchedTasks = taskLookup.all(parsed.shortId) as Array<{ id: string; status: string }>;
      if (matchedTasks.length !== 1) {
        incrementReason(summary, matchedTasks.length === 0 ? "task_not_found" : "task_ambiguous");
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} deferred (${entry.name}): short_id_match_count=${matchedTasks.length}`,
        );
        continue;
      }

      const task = matchedTasks[0]!;
      if (!STARTUP_WORKTREE_AUTOCLEAN_STATUSES.has(task.status)) {
        const reason = STARTUP_WORKTREE_DEFER_STATUSES.has(task.status) ? `status_${task.status}` : "status_other";
        incrementReason(summary, reason);
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} deferred (${entry.name}): task ${task.id} status=${task.status}`,
        );
        continue;
      }

      try {
        runGit(projectPath, ["worktree", "remove", candidatePath, "--force"]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} git remove failed (${candidatePath}): ${message}; falling back to manual cleanup`,
        );
        try {
          if (fs.existsSync(candidatePath)) {
            fs.rmSync(candidatePath, { recursive: true, force: true });
          }
          runGit(projectPath, ["worktree", "prune"]);
        } catch (fallbackError) {
          incrementReason(summary, "cleanup_failed");
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          warn(
            `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} manual cleanup failed (${candidatePath}): ${fallbackMessage}`,
          );
          continue;
        }
      }

      try {
        runGit(projectPath, ["branch", "-D", buildManagedWorktreeBranchName(parsed.shortId, parsed.suffix)]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(
          `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} branch cleanup warning (${entry.name}): ${message}`,
        );
      }

      summary.cleanedCount += 1;
      log(`[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} cleaned ${candidatePath} for task ${task.id}`);
    }
  }

  log(
    `[Claw-Empire] ${STARTUP_WORKTREE_CLEANUP_PREFIX} summary projects=${summary.scannedProjects} candidates=${summary.candidateCount} prune_ok=${summary.pruneSuccessCount} prune_failed=${summary.pruneFailureCount} cleaned=${summary.cleanedCount} deferred=${summary.deferredCount}`,
  );
  return summary;
}

export function startLifecycle(ctx: RuntimeContext): void {
  const {
    IN_PROGRESS_ORPHAN_GRACE_MS,
    IN_PROGRESS_ORPHAN_SWEEP_MS,
    SUBTASK_DELEGATION_SWEEP_MS,
    WebSocket,
    WebSocketServer,
    activeProcesses,
    app,
    appendTaskLog,
    broadcast,
    clearTaskWorkflowState,
    db,
    dbPath,
    detectAllCli,
    distDir,
    endTaskExecutionSession,
    express,
    finishReview,
    getDecryptedOAuthToken,
    handleTaskRunComplete,
    isAgentInMeeting,
    isIncomingMessageAuthenticated,
    isIncomingMessageOriginTrusted,
    isPidAlive,
    isProduction,
    killPidTree,
    notifyCeo,
    nowMs,
    processSubtaskDelegations,
    reconcileCrossDeptSubtasks,
    refreshGoogleToken,
    resolveLang,
    rollbackTaskWorktree,
    runInTransaction,
    startTaskExecutionForAgent,
    stopProgressTimer,
    stopRequestedTasks,
    wsClients,
    logsDir,
  } = ctx as any;

  // ---------------------------------------------------------------------------
  // Production: serve React UI from dist/
  // ---------------------------------------------------------------------------
  if (isProduction) {
    app.use(express.static(distDir));
    // SPA fallback: serve index.html for non-API routes (Express 5 named wildcard)
    app.get(
      "/{*splat}",
      (
        req: { path: string },
        res: {
          status(code: number): { json(payload: unknown): unknown };
          sendFile(filePath: string): unknown;
        },
      ) => {
        if (req.path.startsWith("/api/") || req.path === "/health" || req.path === "/healthz") {
          return res.status(404).json({ error: "not_found" });
        }
        res.sendFile(path.join(distDir, "index.html"));
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Auto break rotation: idle ↔ break every 60s
  // ---------------------------------------------------------------------------
  function rotateBreaks(): void {
    // Rule: max 1 agent per department on break at a time
    const allAgents = db
      .prepare("SELECT id, department_id, status FROM agents WHERE status IN ('idle','break')")
      .all() as { id: string; department_id: string; status: string }[];

    if (allAgents.length === 0) return;

    // Meeting/CEO-office summoned agents should stay in office, not break room.
    for (const a of allAgents) {
      if (a.status === "break" && isAgentInMeeting(a.id)) {
        db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a.id);
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id));
      }
    }

    const candidates = allAgents.filter((a) => !isAgentInMeeting(a.id));
    if (candidates.length === 0) return;

    // Group by department
    const byDept = new Map<string, typeof candidates>();
    for (const a of candidates) {
      const list = byDept.get(a.department_id) || [];
      list.push(a);
      byDept.set(a.department_id, list);
    }

    for (const [, members] of byDept) {
      const onBreak = members.filter((a) => a.status === "break");
      const idle = members.filter((a) => a.status === "idle");

      if (onBreak.length > 1) {
        // Too many on break from same dept — return extras to idle
        const extras = onBreak.slice(1);
        for (const a of extras) {
          db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a.id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id));
        }
      } else if (onBreak.length === 1) {
        // 40% chance to return from break (avg ~2.5 min break)
        if (Math.random() < 0.4) {
          db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(onBreak[0].id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(onBreak[0].id));
        }
      } else if (onBreak.length === 0 && idle.length > 0) {
        // 50% chance to send one idle agent on break
        if (Math.random() < 0.5) {
          const pick = idle[Math.floor(Math.random() * idle.length)];
          db.prepare("UPDATE agents SET status = 'break' WHERE id = ?").run(pick.id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(pick.id));
        }
      }
    }
  }

  function pruneDuplicateReviewMeetings(): void {
    const rows = db
      .prepare(
        `
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY task_id, round, status
          ORDER BY started_at DESC, created_at DESC, id DESC
        ) AS rn
      FROM meeting_minutes
      WHERE meeting_type = 'review'
        AND status IN ('in_progress', 'failed')
    )
    SELECT id
    FROM ranked
    WHERE rn > 1
  `,
      )
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return;

    const delEntries = db.prepare("DELETE FROM meeting_minute_entries WHERE meeting_id = ?");
    const delMeetings = db.prepare("DELETE FROM meeting_minutes WHERE id = ?");
    runInTransaction(() => {
      for (const id of rows.map((r) => r.id)) {
        delEntries.run(id);
        delMeetings.run(id);
      }
    });
  }

  type InProgressRecoveryReason = "startup" | "interval";
  const ORPHAN_RECENT_ACTIVITY_WINDOW_MS = Math.max(120_000, IN_PROGRESS_ORPHAN_GRACE_MS);

  function enqueueOrphanRetry(task: { id: string; title: string; updated_at: number | null }): boolean {
    const policy = readTaskExecutionPolicy(db as any);
    if (!shouldRetryForReason(policy, "orphan_recovery")) return false;

    const existingRow = readTaskRetryQueueRow(db as any, task.id);
    const attemptCount = (existingRow?.attempt_count ?? 0) + 1;
    const now = nowMs();
    if (attemptCount > policy.max_auto_retries) {
      deleteTaskRetryQueueRow(db as any, task.id);
      db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(now, task.id);
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
    db.prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?").run(now, task.id);
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

  function sweepTaskRetryQueue(): void {
    const policy = readTaskExecutionPolicy(db as any);
    if (!policy.enabled) return;

    const dueRows = listDueTaskRetryQueueRows(db as any, nowMs(), 20);
    for (const row of dueRows) {
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.task_id) as
        | {
            id: string;
            title: string;
            status: string;
            assigned_agent_id: string | null;
          }
        | undefined;
      if (!task || task.status !== "pending") {
        deleteTaskRetryQueueRow(db as any, row.task_id);
        recordTaskExecutionEvent(db as any, {
          taskId: row.task_id,
          category: "retry",
          action: "dropped",
          status: "warning",
          message: "Automatic retry dropped: task missing or no longer pending",
          attemptCount: row.attempt_count,
          details: { reason: row.last_reason ?? null, task_missing: !task, task_status: task?.status ?? null },
          createdAt: nowMs(),
        });
        continue;
      }
      if (!task.assigned_agent_id) {
        deleteTaskRetryQueueRow(db as any, row.task_id);
        appendTaskLog(row.task_id, "system", "Automatic retry dropped: no assigned agent");
        recordTaskExecutionEvent(db as any, {
          taskId: row.task_id,
          category: "retry",
          action: "dropped",
          status: "warning",
          message: "Automatic retry dropped: no assigned agent",
          attemptCount: row.attempt_count,
          details: { reason: row.last_reason ?? null },
          createdAt: nowMs(),
        });
        continue;
      }

      const agent = db
        .prepare(
          `SELECT a.id, a.name, a.department_id, a.status, COALESCE(d.name, 'Unassigned') AS department_name
                  , a.name_ko, a.role, a.cli_provider, a.oauth_account_id, a.api_provider_id,
                    a.api_model, a.cli_model, a.cli_reasoning_level, a.personality
           FROM agents a
           LEFT JOIN departments d ON d.id = a.department_id
           WHERE a.id = ?`,
        )
        .get(task.assigned_agent_id) as
        | {
            id: string;
            name: string;
            name_ko: string | null;
            department_id: string | null;
            status: string;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            personality: string | null;
            department_name: string;
          }
        | undefined;
      if (!agent) {
        deleteTaskRetryQueueRow(db as any, row.task_id);
        appendTaskLog(row.task_id, "system", "Automatic retry dropped: assigned agent missing");
        recordTaskExecutionEvent(db as any, {
          taskId: row.task_id,
          category: "retry",
          action: "dropped",
          status: "warning",
          message: "Automatic retry dropped: assigned agent missing",
          attemptCount: row.attempt_count,
          details: { reason: row.last_reason ?? null, assigned_agent_id: task.assigned_agent_id },
          createdAt: nowMs(),
        });
        continue;
      }
      if (activeProcesses.has(row.task_id)) {
        deleteTaskRetryQueueRow(db as any, row.task_id);
        recordTaskExecutionEvent(db as any, {
          taskId: row.task_id,
          category: "retry",
          action: "dropped",
          status: "info",
          message: "Automatic retry dropped: process already active",
          attemptCount: row.attempt_count,
          details: { reason: row.last_reason ?? null },
          createdAt: nowMs(),
        });
        continue;
      }
      if (agent.status === "working" || (agent.status !== "idle" && agent.status !== "break")) {
        rescheduleBusyTaskRetryQueueRow(db as any, row.task_id, nowMs(), 30_000);
        appendTaskLog(row.task_id, "system", `Automatic retry deferred: agent busy (${agent.status})`);
        recordTaskExecutionEvent(db as any, {
          taskId: row.task_id,
          category: "retry",
          action: "deferred",
          status: "info",
          message: `Automatic retry deferred: agent busy (${agent.status})`,
          attemptCount: row.attempt_count,
          details: { reason: row.last_reason ?? null, agent_status: agent.status, delay_ms: 30000 },
          createdAt: nowMs(),
        });
        continue;
      }

      deleteTaskRetryQueueRow(db as any, row.task_id);
      appendTaskLog(row.task_id, "system", `Automatic retry dispatching (attempt=${row.attempt_count})`);
      recordTaskExecutionEvent(db as any, {
        taskId: row.task_id,
        category: "retry",
        action: "dispatching",
        status: "success",
        message: `Automatic retry dispatching (attempt=${row.attempt_count})`,
        attemptCount: row.attempt_count,
        details: { reason: row.last_reason ?? null, agent_id: agent.id, provider: agent.cli_provider ?? null },
        createdAt: nowMs(),
      });
      startTaskExecutionForAgent(row.task_id, agent, agent.department_id ?? null, agent.department_name || "Unassigned");
    }
  }

  function scheduleTaskRetrySweep(delayMs?: number): void {
    const policy = readTaskExecutionPolicy(db as any);
    const nextDelay = Math.max(1_000, delayMs ?? policy.queue_sweep_ms);
    setTimeout(() => {
      try {
        sweepTaskRetryQueue();
      } finally {
        scheduleTaskRetrySweep();
      }
    }, nextDelay);
  }

  function recoverOrphanInProgressTasks(reason: InProgressRecoveryReason): void {
    const inProgressTasks = db
      .prepare(
        `
    SELECT id, title, assigned_agent_id, created_at, started_at, updated_at
    FROM tasks
    WHERE status = 'in_progress'
    ORDER BY updated_at ASC
  `,
      )
      .all() as Array<{
      id: string;
      title: string;
      assigned_agent_id: string | null;
      created_at: number | null;
      started_at: number | null;
      updated_at: number | null;
    }>;

    const now = nowMs();
    for (const task of inProgressTasks) {
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

      // 추가 안전장치 1: task_logs 활동이 최근 윈도우 내에 있으면 아직 활성 상태로 간주
      const recentLog = db
        .prepare(
          `
      SELECT created_at FROM task_logs
      WHERE task_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT 1
    `,
        )
        .get(task.id, now - ORPHAN_RECENT_ACTIVITY_WINDOW_MS) as { created_at: number } | undefined;
      if (recentLog) {
        continue;
      }

      // 추가 안전장치 2: 터미널 로그 파일이 최근까지 갱신됐다면 여전히 출력이 진행 중인 것으로 간주
      // (예: 서버 리로드/재시작으로 in-memory process handle만 유실된 경우)
      try {
        const logPath = path.join(logsDir, `${task.id}.log`);
        const stat = fs.statSync(logPath);
        const logIdleMs = Math.max(0, now - Math.floor(stat.mtimeMs || 0));
        if (logIdleMs <= ORPHAN_RECENT_ACTIVITY_WINDOW_MS) {
          continue;
        }
      } catch {
        // 로그 파일이 없거나 접근 불가하면 기존 복구 로직 진행
      }

      const latestRunLog = db
        .prepare(
          `
      SELECT message
      FROM task_logs
      WHERE task_id = ?
        AND kind = 'system'
        AND (message LIKE 'RUN %' OR message LIKE 'Agent spawn failed:%')
      ORDER BY created_at DESC
      LIMIT 1
    `,
        )
        .get(task.id) as { message: string } | undefined;
      const latestRunMessage = latestRunLog?.message ?? "";

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

      const retried = enqueueOrphanRetry(task);
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
        const t = nowMs();
        const move = db
          .prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ? AND status = 'in_progress'")
          .run(t, task.id) as { changes?: number };
        if ((move.changes ?? 0) === 0) continue;
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
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
        const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
        broadcast("agent_status", updatedAgent);
      }

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
      broadcast("task_update", updatedTask);
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

  function recoverInterruptedWorkflowOnStartup(): void {
    pruneDuplicateReviewMeetings();
    try {
      reconcileCrossDeptSubtasks();
    } catch (err) {
      console.error("[Claw-Empire] startup reconciliation failed:", err);
    }

    recoverOrphanInProgressTasks("startup");
    cleanupStartupOrphanWorktrees({ db: db as DbPrepareLike });

    const reviewTasks = db
      .prepare(
        `
    SELECT t.id, t.title, t.source_task_id, p.status AS parent_status
    FROM tasks t
    LEFT JOIN tasks p ON p.id = t.source_task_id
    WHERE t.status = 'review'
    ORDER BY t.updated_at ASC
  `,
      )
      .all() as Array<{ id: string; title: string; source_task_id: string | null; parent_status: string | null }>;

    filterStartupReviewRecoveryRows(reviewTasks).forEach((task, idx) => {
      const delay = 1200 + idx * 400;
      setTimeout(() => {
        const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as
          | { status: string }
          | undefined;
        if (!current || current.status !== "review") return;
        finishReview(task.id, task.title);
      }, delay);
    });
  }

  function sweepPendingSubtaskDelegations(): void {
    const parents = db
      .prepare(
        `
    SELECT DISTINCT t.id
    FROM tasks t
    LEFT JOIN subtasks s ON s.task_id = t.id
    WHERE t.status IN ('planned', 'collaborating', 'in_progress', 'review')
      AND (
        (
          s.target_department_id IS NOT NULL
          AND s.status != 'done'
          AND (s.delegated_task_id IS NULL OR s.delegated_task_id = '')
        )
        OR (
          COALESCE(t.orchestration_version, 1) >= 2
          AND t.orchestration_stage IN ('owner_integrate', 'finalize', 'foreign_collab')
        )
      )
    ORDER BY t.updated_at ASC
    LIMIT 80
  `,
      )
      .all() as Array<{ id: string }>;

    for (const row of parents) {
      if (!row.id) continue;
      processSubtaskDelegations(row.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-assign agent providers on startup
  // ---------------------------------------------------------------------------
  async function autoAssignAgentProviders(): Promise<void> {
    const autoAssignRow = db.prepare("SELECT value FROM settings WHERE key = 'autoAssign'").get() as
      | { value: string }
      | undefined;
    if (!autoAssignRow || autoAssignRow.value === "false") return;

    const cliStatus = (await detectAllCli()) as Record<string, { installed?: boolean; authenticated?: boolean }>;
    const authenticated = Object.entries(cliStatus)
      .filter(([, s]) => s.installed && s.authenticated)
      .map(([name]) => name);

    if (authenticated.length === 0) {
      console.log("[Claw-Empire] Auto-assign skipped: no authenticated CLI providers");
      return;
    }

    const dpRow = db.prepare("SELECT value FROM settings WHERE key = 'defaultProvider'").get() as
      | { value: string }
      | undefined;
    const defaultProv = dpRow?.value?.replace(/"/g, "") || "claude";
    const fallback = authenticated.includes(defaultProv) ? defaultProv : authenticated[0];

    const agents = db.prepare("SELECT id, name, cli_provider FROM agents").all() as Array<{
      id: string;
      name: string;
      cli_provider: string | null;
    }>;

    let count = 0;
    for (const agent of agents) {
      const prov = agent.cli_provider || "";
      if (prov === "copilot" || prov === "antigravity" || prov === "api") continue;
      if (authenticated.includes(prov)) continue;

      db.prepare("UPDATE agents SET cli_provider = ? WHERE id = ?").run(fallback, agent.id);
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id));
      console.log(`[Claw-Empire] Auto-assigned ${agent.name}: ${prov || "none"} → ${fallback}`);
      count++;
    }
    if (count > 0) console.log(`[Claw-Empire] Auto-assigned ${count} agent(s)`);
  }

  // Run rotation every 60 seconds, and once on startup after 5s
  setTimeout(rotateBreaks, 5_000);
  setInterval(rotateBreaks, 60_000);
  setTimeout(recoverInterruptedWorkflowOnStartup, 3_000);
  setInterval(() => recoverOrphanInProgressTasks("interval"), IN_PROGRESS_ORPHAN_SWEEP_MS);
  scheduleTaskRetrySweep(4_000);
  setTimeout(sweepPendingSubtaskDelegations, 4_000);
  setInterval(sweepPendingSubtaskDelegations, SUBTASK_DELEGATION_SWEEP_MS);
  setTimeout(autoAssignAgentProviders, 4_000);
  const telegramReceiver = startTelegramReceiver({ db });
  const discordReceiver = startDiscordReceiver({ db });

  // ---------------------------------------------------------------------------
  // Start HTTP server + WebSocket
  // ---------------------------------------------------------------------------
  const server = app.listen(PORT, HOST, () => {
    console.log(`[Claw-Empire] v${PKG_VERSION} listening on http://${HOST}:${PORT} (db: ${dbPath})`);
    if (isProduction) {
      console.log(`[Claw-Empire] mode: production (serving UI from ${distDir})`);
    } else {
      console.log(`[Claw-Empire] mode: development (UI served by Vite on separate port)`);
    }
  });

  // Background token refresh: check every 5 minutes for tokens expiring within 5 minutes
  setInterval(
    async () => {
      try {
        const cred = getDecryptedOAuthToken("google_antigravity");
        if (!cred || !cred.refreshToken) return;
        const expiresAtMs = cred.expiresAt && cred.expiresAt < 1e12 ? cred.expiresAt * 1000 : cred.expiresAt;
        if (!expiresAtMs) return;
        // Refresh if expiring within 5 minutes
        if (expiresAtMs < Date.now() + 5 * 60_000) {
          await refreshGoogleToken(cred);
          console.log("[oauth] Background refresh: Antigravity token renewed");
        }
      } catch (err) {
        console.error("[oauth] Background refresh failed:", err instanceof Error ? err.message : err);
      }
    },
    5 * 60 * 1000,
  );

  // WebSocket server on same HTTP server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WsSocket, req: IncomingMessage) => {
    if (!isIncomingMessageOriginTrusted(req) || !isIncomingMessageAuthenticated(req)) {
      ws.close(1008, "unauthorized");
      return;
    }
    wsClients.add(ws);
    console.log(`[Claw-Empire] WebSocket client connected (total: ${wsClients.size})`);

    // Send initial state to the newly connected client
    ws.send(
      JSON.stringify({
        type: "connected",
        payload: {
          version: PKG_VERSION,
          app: "Claw-Empire",
        },
        ts: nowMs(),
      }),
    );

    ws.on("close", () => {
      wsClients.delete(ws);
      console.log(`[Claw-Empire] WebSocket client disconnected (total: ${wsClients.size})`);
    });

    ws.on("error", () => {
      wsClients.delete(ws);
    });
  });

  registerGracefulShutdownHandlers({
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    rollbackTaskWorktree,
    db,
    nowMs,
    endTaskExecutionSession,
    wsClients,
    wss,
    server,
    onBeforeClose: () => {
      telegramReceiver.stop();
      discordReceiver.stop();
    },
  });
}
