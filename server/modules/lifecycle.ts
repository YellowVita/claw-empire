import type { IncomingMessage } from "node:http";
import type { WebSocket as WsSocket } from "ws";
import path from "path";

import type { RuntimeContext } from "../types/runtime-context.ts";
import { HOST as RUNTIME_HOST, PKG_VERSION, PORT } from "../config/runtime.ts";
import { notifyTaskStatus } from "../gateway/client.ts";
import { startDiscordReceiver } from "../messenger/discord-receiver.ts";
import { startTelegramReceiver } from "../messenger/telegram-receiver.ts";
import { getAgentById, listAgentsForAutoAssign, setAgentProvider } from "../db/queries/agent-queries.ts";
import { deleteReviewMeetingCascade, listDuplicateReviewMeetingIds } from "../db/queries/meeting-queries.ts";
import { getTaskStatusById, listStartupReviewTasks } from "../db/queries/task-queries.ts";
import { readTaskExecutionPolicy } from "./workflow/orchestration/task-execution-policy.ts";
import { registerGracefulShutdownHandlers } from "./lifecycle/register-graceful-shutdown.ts";
import { rotateBreaks } from "./lifecycle/break-rotation.ts";
import { recoverOrphanInProgressTasks } from "./lifecycle/orphan-recovery.ts";
import { recoverOrphanWorkingAgents } from "./lifecycle/orphan-working-agent-recovery.ts";
import { sweepPendingSubtaskDelegations } from "./lifecycle/pending-subtask-delegation-sweep.ts";
import {
  cleanupStartupOrphanWorktrees,
  type StartupOrphanWorktreeCleanupDeps,
  type StartupOrphanWorktreeCleanupSummary,
} from "./lifecycle/startup-orphan-worktree-cleanup.ts";
import {
  hydrateStartupWorktrees,
  type StartupWorktreeHydrationSummary,
} from "./lifecycle/startup-worktree-hydration.ts";
import { filterStartupReviewRecoveryRows } from "./lifecycle/review-recovery.ts";
import { sweepTaskRetryQueue } from "./lifecycle/task-retry-sweep.ts";

export {
  cleanupStartupOrphanWorktrees,
  type StartupOrphanWorktreeCleanupDeps,
  type StartupOrphanWorktreeCleanupSummary,
  hydrateStartupWorktrees,
  type StartupWorktreeHydrationSummary,
};

function pruneDuplicateReviewMeetings(ctx: RuntimeContext): void {
  const rows = listDuplicateReviewMeetingIds(ctx.db as any);
  if (rows.length === 0) return;
  ctx.runInTransaction(() => {
    for (const id of rows) {
      deleteReviewMeetingCascade(ctx.db as any, id);
    }
  });
}

function recoverInterruptedWorkflowOnStartup(ctx: RuntimeContext): void {
  pruneDuplicateReviewMeetings(ctx);
  try {
    ctx.repairExplicitRoleSubtaskRouting();
  } catch (err) {
    console.error("[Claw-Empire] startup explicit-role routing repair failed:", err);
  }
  try {
    ctx.reconcileCrossDeptSubtasks();
  } catch (err) {
    console.error("[Claw-Empire] startup reconciliation failed:", err);
  }

  recoverOrphanInProgressTasks(
    {
      db: ctx.db as any,
      activeProcesses: ctx.activeProcesses,
      IN_PROGRESS_ORPHAN_GRACE_MS: ctx.IN_PROGRESS_ORPHAN_GRACE_MS,
      logsDir: ctx.logsDir,
      appendTaskLog: ctx.appendTaskLog,
      broadcast: ctx.broadcast,
      clearTaskWorkflowState: ctx.clearTaskWorkflowState,
      endTaskExecutionSession: ctx.endTaskExecutionSession,
      handleTaskRunComplete: ctx.handleTaskRunComplete,
      isPidAlive: ctx.isPidAlive,
      notifyCeo: ctx.notifyCeo,
      nowMs: ctx.nowMs,
      resolveLang: ctx.resolveLang,
      stopProgressTimer: ctx.stopProgressTimer,
      notifyTaskStatus,
    },
    "startup",
  );
  recoverOrphanWorkingAgents({ db: ctx.db as any, broadcast: ctx.broadcast }, "startup");
  cleanupStartupOrphanWorktrees({ db: ctx.db as any });
  hydrateStartupWorktrees({ db: ctx.db as any, taskWorktrees: ctx.taskWorktrees });

  filterStartupReviewRecoveryRows(listStartupReviewTasks(ctx.db as any)).forEach((task, idx) => {
    const delay = 1200 + idx * 400;
    setTimeout(() => {
      if (getTaskStatusById(ctx.db as any, task.id) !== "review") return;
      ctx.finishReview(task.id, task.title);
    }, delay);
  });
}

function scheduleTaskRetrySweep(ctx: RuntimeContext, delayMs?: number): void {
  const policy = readTaskExecutionPolicy(ctx.db as any);
  const nextDelay = Math.max(1_000, delayMs ?? policy.queue_sweep_ms);
  setTimeout(() => {
    try {
      sweepTaskRetryQueue({
        db: ctx.db as any,
        activeProcesses: ctx.activeProcesses,
        appendTaskLog: ctx.appendTaskLog,
        nowMs: ctx.nowMs,
        startTaskExecutionForAgent: ctx.startTaskExecutionForAgent,
      });
    } finally {
      scheduleTaskRetrySweep(ctx);
    }
  }, nextDelay);
}

async function autoAssignAgentProviders(ctx: RuntimeContext): Promise<void> {
  const autoAssignRow = ctx.db.prepare("SELECT value FROM settings WHERE key = 'autoAssign'").get() as
    | { value: string }
    | undefined;
  if (!autoAssignRow || autoAssignRow.value === "false") return;

  const cliStatus = (await ctx.detectAllCli()) as Record<string, { installed?: boolean; authenticated?: boolean }>;
  const authenticated = Object.entries(cliStatus)
    .filter(([, status]) => status.installed && status.authenticated)
    .map(([name]) => name);

  if (authenticated.length === 0) {
    console.log("[Claw-Empire] Auto-assign skipped: no authenticated CLI providers");
    return;
  }

  const dpRow = ctx.db.prepare("SELECT value FROM settings WHERE key = 'defaultProvider'").get() as
    | { value: string }
    | undefined;
  const defaultProv = dpRow?.value?.replace(/"/g, "") || "claude";
  const fallback = authenticated.includes(defaultProv) ? defaultProv : authenticated[0];

  let count = 0;
  for (const agent of listAgentsForAutoAssign(ctx.db as any)) {
    const provider = agent.cli_provider || "";
    if (provider === "copilot" || provider === "antigravity" || provider === "api") continue;
    if (authenticated.includes(provider)) continue;

    setAgentProvider(ctx.db as any, agent.id, fallback);
    ctx.broadcast("agent_status", getAgentById(ctx.db as any, agent.id));
    console.log(`[Claw-Empire] Auto-assigned ${agent.name}: ${provider || "none"} -> ${fallback}`);
    count += 1;
  }
  if (count > 0) console.log(`[Claw-Empire] Auto-assigned ${count} agent(s)`);
}

export function startLifecycle(ctx: RuntimeContext): void {
  const {
    app,
    broadcast,
    db,
    dbPath,
    distDir,
    express,
    getDecryptedOAuthToken,
    isIncomingMessageAuthenticated,
    isIncomingMessageOriginTrusted,
    isProduction,
    killPidTree,
    logsDir,
    nowMs,
    refreshGoogleToken,
    rollbackTaskWorktree,
    stopRequestedTasks,
    WebSocketServer,
    wsClients,
  } = ctx as any;

  if (isProduction) {
    app.use(express.static(distDir));
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

  setTimeout(() => rotateBreaks({ db: db as any, broadcast, isAgentInMeeting: ctx.isAgentInMeeting }), 5_000);
  setInterval(
    () => rotateBreaks({ db: db as any, broadcast, isAgentInMeeting: ctx.isAgentInMeeting }),
    60_000,
  );
  setTimeout(() => recoverInterruptedWorkflowOnStartup(ctx), 3_000);
  setInterval(
    () =>
      recoverOrphanInProgressTasks(
        {
          db: ctx.db as any,
          activeProcesses: ctx.activeProcesses,
          IN_PROGRESS_ORPHAN_GRACE_MS: ctx.IN_PROGRESS_ORPHAN_GRACE_MS,
          logsDir,
          appendTaskLog: ctx.appendTaskLog,
          broadcast,
          clearTaskWorkflowState: ctx.clearTaskWorkflowState,
          endTaskExecutionSession: ctx.endTaskExecutionSession,
          handleTaskRunComplete: ctx.handleTaskRunComplete,
          isPidAlive: ctx.isPidAlive,
          notifyCeo: ctx.notifyCeo,
          nowMs: ctx.nowMs,
          resolveLang: ctx.resolveLang,
          stopProgressTimer: ctx.stopProgressTimer,
          notifyTaskStatus,
        },
        "interval",
      ),
    ctx.IN_PROGRESS_ORPHAN_SWEEP_MS,
  );
  setInterval(
    () => recoverOrphanWorkingAgents({ db: ctx.db as any, broadcast }, "interval"),
    ctx.IN_PROGRESS_ORPHAN_SWEEP_MS,
  );
  scheduleTaskRetrySweep(ctx, 4_000);
  setTimeout(
    () => sweepPendingSubtaskDelegations({ db: ctx.db as any, processSubtaskDelegations: ctx.processSubtaskDelegations }),
    4_000,
  );
  setInterval(
    () => sweepPendingSubtaskDelegations({ db: ctx.db as any, processSubtaskDelegations: ctx.processSubtaskDelegations }),
    ctx.SUBTASK_DELEGATION_SWEEP_MS,
  );
  setTimeout(() => void autoAssignAgentProviders(ctx), 4_000);

  const telegramReceiver = startTelegramReceiver({ db });
  const discordReceiver = startDiscordReceiver({ db });

  const httpServer = app.listen(PORT, RUNTIME_HOST, () => {
    console.log(`[Claw-Empire] v${PKG_VERSION} listening on http://${RUNTIME_HOST}:${PORT} (db: ${dbPath})`);
    if (isProduction) {
      console.log(`[Claw-Empire] mode: production (serving UI from ${distDir})`);
    } else {
      console.log(`[Claw-Empire] mode: development (UI served by Vite on separate port)`);
    }
  });

  setInterval(
    async () => {
      try {
        const cred = getDecryptedOAuthToken("google_antigravity");
        if (!cred || !cred.refreshToken) return;
        const expiresAtMs = cred.expiresAt && cred.expiresAt < 1e12 ? cred.expiresAt * 1000 : cred.expiresAt;
        if (!expiresAtMs) return;
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

  const wsServer = new WebSocketServer({ server: httpServer });
  wsServer.on("connection", (ws: WsSocket, req: IncomingMessage) => {
    if (!isIncomingMessageOriginTrusted(req) || !isIncomingMessageAuthenticated(req)) {
      ws.close(1008, "unauthorized");
      return;
    }
    wsClients.add(ws);
    console.log(`[Claw-Empire] WebSocket client connected (total: ${wsClients.size})`);

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
    activeProcesses: ctx.activeProcesses,
    stopRequestedTasks,
    killPidTree,
    rollbackTaskWorktree,
    db,
    nowMs,
    endTaskExecutionSession: ctx.endTaskExecutionSession,
    wsClients,
    wss: wsServer,
    server: httpServer,
    onBeforeClose: () => {
      telegramReceiver.stop();
      discordReceiver.stop();
    },
  });
}
