import path from "node:path";
import type { Lang } from "../../../types/lang.ts";
import type { AgentRow } from "./direct-chat.ts";
import { buildManagedWorktreePath, getTaskShortId } from "../../workflow/core/worktree/lifecycle.ts";
import { reconcileVideoRenderDelegationState } from "../../workflow/orchestration/video-render-delegation-state.ts";
import {
  buildOwnerIntegrationInstruction,
  getLegacyForeignDelegationReadiness,
  getTaskOrchestrationStage,
  inferOrchestrationPhaseFromSubtask,
  isTaskOrchestrationV2,
  ORCHESTRATION_V2_FOREIGN_PARALLELISM,
} from "../../workflow/orchestration/subtask-orchestration-v2.ts";
import { readYoloModeEnabled } from "../../routes/ops/messages/decision-inbox/yolo-mode.ts";
import { createSubtaskDelegationBatch } from "./subtask-delegation-batch.ts";
import { createSubtaskDelegationPromptBuilder } from "./subtask-delegation-prompt.ts";
import { initializeSubtaskSummary, type SubtaskRow } from "./subtask-summary.ts";
import type { L10n } from "./language-policy.ts";

interface SubtaskDelegationDeps {
  db: any;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  getPreferredLanguage: () => Lang;
  getDeptName: (deptId: string, workflowPackKey?: string | null) => string;
  getDeptRoleConstraint: (deptId: string, deptName: string) => string;
  getRecentConversationContext: (agentId: string, limit?: number) => string;
  getAgentDisplayName: (agent: AgentRow, lang: string) => string;
  buildTaskExecutionPrompt: (parts: string[], opts?: { allowWarningFix?: boolean }) => string;
  hasExplicitWarningFixRequest: (...textParts: Array<string | null | undefined>) => boolean;
  delegatedTaskToSubtask: Map<string, string>;
  subtaskDelegationCallbacks: Map<string, () => void>;
  subtaskDelegationDispatchInFlight: Set<string>;
  subtaskDelegationCompletionNoticeSent: Set<string>;
  notifyCeo: (content: string, taskId?: string | null, messageType?: string) => void;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
  appendTaskLog: (taskId: string, source: string, message: string) => void;
  finishReview: (
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
  ) => void;
  findTeamLeader: (deptId: string | null, candidateAgentIds?: string[] | null) => AgentRow | null;
  findBestSubordinate: (deptId: string, excludeId: string, candidateAgentIds?: string[] | null) => AgentRow | null;
  nowMs: () => number;
  broadcast: (event: string, payload: unknown) => void;
  handleTaskRunComplete: (taskId: string, exitCode: number) => void;
  stopRequestedTasks: Set<string>;
  stopRequestModeByTask: Map<string, "pause" | "cancel">;
  recordTaskCreationAudit: (payload: any) => void;
  resolveProjectPath: (taskLike: {
    project_id?: string | null;
    project_path?: string | null;
    description?: string | null;
    title?: string | null;
  }) => string | null;
  createWorktree: (projectPath: string, taskId: string, agentName: string, baseBranch?: string) => string | null;
  logsDir: string;
  ensureTaskExecutionSession: (
    taskId: string,
    agentId: string,
    provider: string,
  ) => {
    sessionId: string;
    agentId: string;
    provider: string;
  };
  ensureClaudeMd: (projectPath: string, worktreePath: string) => void;
  getProviderModelConfig: () => Record<string, { model?: string; reasoningLevel?: string }>;
  spawnCliAgent: (
    taskId: string,
    provider: string,
    prompt: string,
    cwd: string,
    logFilePath: string,
    model?: string,
    reasoningLevel?: string,
  ) => {
    on: (event: "close", listener: (code: number | null) => void) => void;
  };
  getNextHttpAgentPid: () => number;
  launchApiProviderAgent: (
    taskId: string,
    apiProviderId: string | null,
    apiModel: string | null,
    prompt: string,
    cwd: string,
    logFilePath: string,
    controller: AbortController,
    fakePid: number,
  ) => void;
  launchHttpAgent: (
    taskId: string,
    provider: string,
    prompt: string,
    cwd: string,
    logFilePath: string,
    controller: AbortController,
    fakePid: number,
    oauthAccountId: string | null,
  ) => void;
  startProgressTimer: (taskId: string, taskTitle: string, departmentId: string | null) => void;
  startTaskExecutionForAgent: (taskId: string, agent: AgentRow, deptId: string | null, deptName: string) => void;
  activeProcesses: Map<string, unknown>;
}

export function initializeSubtaskDelegation(deps: SubtaskDelegationDeps) {
  const {
    db,
    l,
    pickL,
    resolveLang,
    getPreferredLanguage,
    getDeptName,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getAgentDisplayName,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    delegatedTaskToSubtask,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    subtaskDelegationCompletionNoticeSent,
    notifyCeo,
    sendAgentMessage,
    appendTaskLog,
    finishReview,
    findTeamLeader,
    findBestSubordinate,
    nowMs,
    broadcast,
    handleTaskRunComplete,
    stopRequestedTasks,
    stopRequestModeByTask,
    recordTaskCreationAudit,
    resolveProjectPath,
    createWorktree,
    logsDir,
    ensureTaskExecutionSession,
    ensureClaudeMd,
    getProviderModelConfig,
    spawnCliAgent,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    startProgressTimer,
    startTaskExecutionForAgent,
    activeProcesses,
  } = deps;
  const pendingDelegationOptionsByTask = new Map<string, { includeRender?: boolean }>();
  const autoResumeRetryTimers = new Map<string, NodeJS.Timeout>();
  const autoResumeRetryAttempts = new Map<string, number>();
  const delegationRetryTimers = new Map<string, NodeJS.Timeout>();
  const delegationRetryAttempts = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // Subtask cross-department delegation: sequential by department,
  // one batched request per department.
  // ---------------------------------------------------------------------------
  const { formatTaskSubtaskProgressSummary, groupSubtasksByTargetDepartment, orderSubtaskQueuesByDepartment } =
    initializeSubtaskSummary({ db, l, pickL });
  const { buildSubtaskDelegationPrompt } = createSubtaskDelegationPromptBuilder({
    db,
    l,
    pickL,
    resolveLang,
    getDeptName,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getAgentDisplayName,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
  });

  function stripOrchestrationBlock(description: string | null): string {
    return String(description ?? "")
      .replace(/\n?\[ORCHESTRATION V2\][\s\S]*$/m, "")
      .trimEnd();
  }

  function updateTaskOrchestrationStage(taskId: string, stage: string, status?: string): void {
    const t = nowMs();
    if (status) {
      db.prepare("UPDATE tasks SET orchestration_stage = ?, status = ?, updated_at = ? WHERE id = ?").run(
        stage,
        status,
        t,
        taskId,
      );
    } else {
      db.prepare("UPDATE tasks SET orchestration_stage = ?, updated_at = ? WHERE id = ?").run(stage, t, taskId);
    }
    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
  }

  function buildSiblingWorktreeReferenceBlock(taskId: string, projectPath: string): string {
    const siblingRows = db
      .prepare(
        `
        SELECT s.title, s.target_department_id, s.delegated_task_id
        FROM subtasks s
        WHERE s.task_id = ?
          AND s.status = 'done'
          AND s.delegated_task_id IS NOT NULL
          AND TRIM(s.delegated_task_id) != ''
        ORDER BY s.created_at ASC
      `,
      )
      .all(taskId) as Array<{
      title: string;
      target_department_id: string | null;
      delegated_task_id: string | null;
    }>;
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const row of siblingRows) {
      const delegatedTaskId = String(row.delegated_task_id ?? "").trim();
      if (!delegatedTaskId || seen.has(delegatedTaskId)) continue;
      seen.add(delegatedTaskId);
      const worktreePath = buildManagedWorktreePath(projectPath, getTaskShortId(delegatedTaskId));
      const deptLabel = row.target_department_id
        ? getDeptName(row.target_department_id)
        : pickL(l(["부서 미지정"], ["Unassigned department"], ["未指定部門"], ["未指定部门"]), getPreferredLanguage());
      lines.push(`- [${deptLabel}] ${worktreePath}`);
    }
    if (lines.length === 0) return "";
    return [
      "[Read-only Department Deliverables]",
      "Read the following delegated-task worktrees and integrate their outputs into the owner worktree.",
      "These paths are read-only references. Do not modify files in those worktrees.",
      ...lines,
    ].join("\n");
  }

  function resumeOwnerIntegrationTask(taskId: string): void {
    const parentTask = db
      .prepare(
        `
        SELECT id, title, description, status, project_id, project_path, department_id, assigned_agent_id, workflow_pack_key,
               orchestration_version, orchestration_stage
        FROM tasks
        WHERE id = ?
      `,
      )
      .get(taskId) as
      | {
          id: string;
          title: string;
          description: string | null;
          status: string;
          project_id: string | null;
          project_path: string | null;
          department_id: string | null;
          assigned_agent_id: string | null;
          workflow_pack_key: string | null;
          orchestration_version: number | null;
          orchestration_stage: string | null;
        }
      | undefined;
    if (!parentTask || !isTaskOrchestrationV2(parentTask)) return;
    if (getTaskOrchestrationStage(parentTask) !== "owner_integrate") return;
    if (activeProcesses.has(taskId)) return;

    const ownRemaining = db
      .prepare(
        `
        SELECT COUNT(*) AS cnt
        FROM subtasks
        WHERE task_id = ?
          AND status NOT IN ('done', 'cancelled')
          AND (orchestration_phase = 'owner_integrate' OR (orchestration_phase IS NULL AND target_department_id IS NULL))
      `,
      )
      .get(taskId) as { cnt: number };
    if ((ownRemaining?.cnt ?? 0) === 0) return;

    const assignee = parentTask.assigned_agent_id
      ? (db.prepare("SELECT * FROM agents WHERE id = ?").get(parentTask.assigned_agent_id) as AgentRow | undefined)
      : undefined;
    if (!assignee) {
      appendTaskLog(taskId, "system", "Owner integration resume blocked: assigned owner agent not found");
      return;
    }
    if (assignee.status === "working" && assignee.current_task_id && assignee.current_task_id !== taskId) {
      appendTaskLog(taskId, "system", `Owner integration resume deferred: ${assignee.name} is busy on ${assignee.current_task_id}`);
      return;
    }

    const projectPath = resolveProjectPath({
      project_id: parentTask.project_id,
      project_path: parentTask.project_path,
      description: parentTask.description,
      title: parentTask.title,
    });
    if (!projectPath) {
      appendTaskLog(taskId, "system", "Owner integration resume blocked: missing project path");
      return;
    }
    const ownerIntegrationBlock = [
      buildOwnerIntegrationInstruction(parentTask.title),
      buildSiblingWorktreeReferenceBlock(taskId, projectPath),
    ]
      .filter(Boolean)
      .join("\n\n");
    const nextDescription = [stripOrchestrationBlock(parentTask.description), ownerIntegrationBlock]
      .filter(Boolean)
      .join("\n\n");
    db.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?").run(nextDescription, nowMs(), taskId);
    updateTaskOrchestrationStage(taskId, "owner_integrate", "planned");
    appendTaskLog(taskId, "system", "V2 orchestration: foreign collaboration complete, resuming owner integration");
    startTaskExecutionForAgent(taskId, assignee, parentTask.department_id, getDeptName(parentTask.department_id ?? ""));
  }

  function clearAutoResumeRetry(taskId: string): void {
    const timer = autoResumeRetryTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      autoResumeRetryTimers.delete(taskId);
    }
    autoResumeRetryAttempts.delete(taskId);
  }

  function clearDelegationRetry(taskId: string): void {
    const timer = delegationRetryTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      delegationRetryTimers.delete(taskId);
    }
    delegationRetryAttempts.delete(taskId);
  }

  function scheduleDelegationRetry(
    taskId: string,
    title: string,
    lang: Lang,
    ownerPrepBlockerCount: number,
    taskStatus: string,
  ): void {
    if (delegationRetryTimers.has(taskId)) return;
    const nextAttempt = (delegationRetryAttempts.get(taskId) ?? 0) + 1;
    delegationRetryAttempts.set(taskId, nextAttempt);
    const delayMs = Math.min(15_000 * nextAttempt, 120_000);
    appendTaskLog(
      taskId,
      "system",
      `Subtask delegation retry scheduled in ${Math.round(delayMs / 1000)}s (attempt ${nextAttempt}; owner_prep_blockers=${ownerPrepBlockerCount}; status=${taskStatus})`,
    );
    if (nextAttempt === 1 || nextAttempt % 3 === 0) {
      notifyCeo(
        pickL(
          l(
            [
              `'${title}' 는 owner_prep 서브태스크 ${ownerPrepBlockerCount}건이 아직 남아 있어 외부 부서 위임을 잠시 대기합니다. 자동 재시도 예정입니다.`,
            ],
            [
              `'${title}' is waiting to delegate external subtasks because ${ownerPrepBlockerCount} owner_prep subtasks are still unfinished. It will retry automatically.`,
            ],
            [
              `'${title}' は owner_prep サブタスク${ownerPrepBlockerCount}件が未完了のため、他部門委任を一時待機しています。自動再試行します。`,
            ],
            [
              `'${title}' 因仍有 ${ownerPrepBlockerCount} 个 owner_prep 子任务未完成，暂缓对外部门委派。系统将自动重试。`,
            ],
          ),
          lang,
        ),
        taskId,
      );
    }
    const timer = setTimeout(() => {
      delegationRetryTimers.delete(taskId);
      processSubtaskDelegations(taskId);
    }, delayMs);
    timer.unref?.();
    delegationRetryTimers.set(taskId, timer);
  }

  function scheduleAutoResumeRetry(taskId: string, reason: string): void {
    if (autoResumeRetryTimers.has(taskId)) return;
    const nextAttempt = (autoResumeRetryAttempts.get(taskId) ?? 0) + 1;
    autoResumeRetryAttempts.set(taskId, nextAttempt);
    const delayMs = Math.min(15_000 * nextAttempt, 120_000);
    appendTaskLog(
      taskId,
      "system",
      `Auto-resume retry scheduled in ${Math.round(delayMs / 1000)}s (attempt ${nextAttempt}; reason=${reason})`,
    );
    const timer = setTimeout(() => {
      autoResumeRetryTimers.delete(taskId);
      maybeNotifyAllSubtasksComplete(taskId);
    }, delayMs);
    timer.unref?.();
    autoResumeRetryTimers.set(taskId, timer);
  }

  function hasOpenForeignSubtasks(taskId: string, targetDeptIds: string[] = []): boolean {
    const uniqueDeptIds = [...new Set(targetDeptIds.filter(Boolean))];
    if (uniqueDeptIds.length > 0) {
      const placeholders = uniqueDeptIds.map(() => "?").join(", ");
      const row = db
        .prepare(
          `
    SELECT 1
    FROM subtasks
    WHERE task_id = ?
      AND target_department_id IN (${placeholders})
      AND target_department_id IS NOT NULL
      AND status NOT IN ('done', 'cancelled')
      AND (delegated_task_id IS NULL OR delegated_task_id = '')
    LIMIT 1
  `,
        )
        .get(taskId, ...uniqueDeptIds);
      return !!row;
    }

    const row = db
      .prepare(
        `
  SELECT 1
  FROM subtasks
  WHERE task_id = ?
    AND target_department_id IS NOT NULL
    AND status NOT IN ('done', 'cancelled')
    AND (delegated_task_id IS NULL OR delegated_task_id = '')
  LIMIT 1
`,
      )
      .get(taskId);
    return !!row;
  }

  function processSubtaskDelegations(taskId: string, opts?: { includeRender?: boolean }): void {
    if (subtaskDelegationDispatchInFlight.has(taskId)) {
      const previous = pendingDelegationOptionsByTask.get(taskId);
      pendingDelegationOptionsByTask.set(taskId, {
        includeRender: Boolean(previous?.includeRender || opts?.includeRender),
      });
      if (opts?.includeRender) {
        appendTaskLog(
          taskId,
          "system",
          "Subtask delegation queued: includeRender request deferred until in-flight batch completes",
        );
      }
      return;
    }

    const parentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          id: string;
          title: string;
          description: string | null;
          status: string;
          project_id: string | null;
          project_path: string | null;
          department_id: string | null;
          assigned_agent_id: string | null;
          orchestration_version: number | null;
          orchestration_stage: string | null;
        }
      | undefined;
    if (!parentTask) {
      clearDelegationRetry(taskId);
      return;
    }
    const lang = resolveLang(parentTask.description ?? parentTask.title);
    const isV2 = isTaskOrchestrationV2(parentTask);
    const orchestrationStage = getTaskOrchestrationStage(parentTask);

    if (isV2 && orchestrationStage === "owner_integrate") {
      clearDelegationRetry(taskId);
      resumeOwnerIntegrationTask(taskId);
      return;
    }

    const foreignSubtasksAll = db
      .prepare(
        "SELECT * FROM subtasks WHERE task_id = ? AND target_department_id IS NOT NULL AND status NOT IN ('done', 'cancelled') ORDER BY created_at",
      )
      .all(taskId) as unknown as SubtaskRow[];

    const relevantForeignSubtasks = isV2
      ? foreignSubtasksAll.filter((subtask) => {
          const phase = inferOrchestrationPhaseFromSubtask(subtask);
          if (orchestrationStage === "finalize") return phase === "finalize";
          if (orchestrationStage === "foreign_collab") return phase === "foreign_collab";
          return false;
        })
      : foreignSubtasksAll;

    if (relevantForeignSubtasks.length === 0) {
      clearDelegationRetry(taskId);
      if (isV2 && orchestrationStage === "foreign_collab") {
        updateTaskOrchestrationStage(taskId, "owner_integrate", "collaborating");
        resumeOwnerIntegrationTask(taskId);
      }
      return;
    }

    const incompleteForeign = relevantForeignSubtasks;
    const undelegatedForeign = incompleteForeign.filter((subtask) => !String(subtask.delegated_task_id ?? "").trim());
    const eligible = undelegatedForeign.filter((subtask) => {
      if (isV2 && orchestrationStage === "finalize") return true;
      if (opts?.includeRender) return true;
      return !String(subtask.title ?? "").includes("[VIDEO_FINAL_RENDER]");
    });

    if (eligible.length === 0) {
      clearDelegationRetry(taskId);
      if (isV2 && orchestrationStage === "foreign_collab") {
        const unresolvedForeign = incompleteForeign.filter((subtask) => subtask.status !== "blocked");
        if (unresolvedForeign.length === 0) {
          appendTaskLog(taskId, "system", "V2 orchestration: foreign collaboration remains blocked; owner integration will not start");
        }
      }
      return;
    }

    if (!isV2) {
      const openSubtasks = db
        .prepare("SELECT * FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled') ORDER BY created_at")
        .all(taskId) as unknown as SubtaskRow[];
      const readiness = getLegacyForeignDelegationReadiness(parentTask, openSubtasks);
      if (!readiness.ready) {
        appendTaskLog(
          taskId,
          "system",
          `Subtask delegation deferred: ${readiness.ownerPrepBlockerCount} owner_prep blocker(s) remain (owner_open=${readiness.ownerSideOpenCount}, status=${parentTask.status}). Foreign delegation will start after owner prep clears.`,
        );
        scheduleDelegationRetry(taskId, parentTask.title, lang, readiness.ownerPrepBlockerCount, parentTask.status);
        return;
      }
      if (readiness.ownerIntegrateOpenCount > 0) {
        appendTaskLog(
          taskId,
          "system",
          `Subtask delegation proceeding: owner_prep clear; ${readiness.ownerIntegrateOpenCount} owner_integrate subtask(s) remain but do not block foreign delegation.`,
        );
      }
    }
    clearDelegationRetry(taskId);
    const queues = orderSubtaskQueuesByDepartment(groupSubtasksByTargetDepartment(eligible));
    const deptCount = queues.length;
    subtaskDelegationDispatchInFlight.add(taskId);
    subtaskDelegationCompletionNoticeSent.delete(parentTask.id);

    notifyCeo(
      pickL(
        l(
          [
            isV2 && orchestrationStage === "foreign_collab"
              ? `'${parentTask.title}' 의 foreign_collab 서브태스크 ${eligible.length}건을 최대 ${ORCHESTRATION_V2_FOREIGN_PARALLELISM}개 부서까지 제한 병렬로 위임합니다.`
              : `'${parentTask.title}' 의 외부 부서 서브태스크 ${eligible.length}건을 부서별 배치로 순차 위임합니다.`,
          ],
          [
            isV2 && orchestrationStage === "foreign_collab"
              ? `Delegating ${eligible.length} foreign_collab subtasks for '${parentTask.title}' with capped parallelism (${ORCHESTRATION_V2_FOREIGN_PARALLELISM} departments max).`
              : `Delegating ${eligible.length} external-department subtasks for '${parentTask.title}' sequentially by department, one batched request at a time.`,
          ],
          [
            isV2 && orchestrationStage === "foreign_collab"
              ? `'${parentTask.title}' の foreign_collab サブタスク${eligible.length}件を、最大${ORCHESTRATION_V2_FOREIGN_PARALLELISM}部門まで制限並列で委任します。`
              : `'${parentTask.title}' の他部門サブタスク${eligible.length}件を、部門ごとにバッチ化して順次委任します。`,
          ],
          [
            isV2 && orchestrationStage === "foreign_collab"
              ? `将把'${parentTask.title}'的 ${eligible.length} 个 foreign_collab 子任务以最多 ${ORCHESTRATION_V2_FOREIGN_PARALLELISM} 个部门的限制并行方式委派。`
              : `将把'${parentTask.title}'的${eligible.length}个外部门 SubTask 按部门批量后顺序委派。`,
          ],
        ),
        lang,
      ),
      taskId,
    );
    appendTaskLog(
      taskId,
      "system",
      isV2 && orchestrationStage === "foreign_collab"
        ? `Subtask delegation mode: capped_parallel_by_department_batched (parallelism=${ORCHESTRATION_V2_FOREIGN_PARALLELISM}, queues=${deptCount}, items=${eligible.length})`
        : `Subtask delegation mode: sequential_by_department_batched (queues=${deptCount}, items=${eligible.length})`,
    );
    const drainDeferred = () => {
      const pending = pendingDelegationOptionsByTask.get(taskId);
      if (pending) {
        appendTaskLog(
          taskId,
          "system",
          `Subtask delegation draining deferred request (includeRender=${pending.includeRender === true})`,
        );
        setTimeout(() => {
          const nextPending = pendingDelegationOptionsByTask.get(taskId) ?? pending;
          pendingDelegationOptionsByTask.delete(taskId);
          processSubtaskDelegations(taskId, nextPending);
          maybeNotifyAllSubtasksComplete(parentTask.id);
        }, 150);
        return;
      }
      maybeNotifyAllSubtasksComplete(parentTask.id);
    };

    if (!isV2 || orchestrationStage !== "foreign_collab") {
      const runQueue = (index: number) => {
        if (index >= queues.length) {
          subtaskDelegationDispatchInFlight.delete(taskId);
          drainDeferred();
          return;
        }
        delegateSubtaskBatch(queues[index], index, queues.length, parentTask, () => {
          const nextDelay = 900 + Math.random() * 700;
          setTimeout(() => runQueue(index + 1), nextDelay);
        });
      };
      runQueue(0);
      return;
    }

    const activeDelegatedTasks = new Set(
      incompleteForeign.map((subtask) => String(subtask.delegated_task_id ?? "").trim()).filter((id) => id.length > 0),
    );
    const availableSlots = Math.max(0, ORCHESTRATION_V2_FOREIGN_PARALLELISM - activeDelegatedTasks.size);
    if (availableSlots === 0) {
      subtaskDelegationDispatchInFlight.delete(taskId);
      appendTaskLog(taskId, "system", `V2 orchestration: foreign collaboration slots full (${activeDelegatedTasks.size}/${ORCHESTRATION_V2_FOREIGN_PARALLELISM})`);
      return;
    }

    const launchCount = Math.min(availableSlots, queues.length);
    for (let index = 0; index < launchCount; index += 1) {
      delegateSubtaskBatch(queues[index], index, queues.length, parentTask, () => {
        setTimeout(() => processSubtaskDelegations(taskId), 250);
      });
    }
    subtaskDelegationDispatchInFlight.delete(taskId);
    if (launchCount < queues.length) {
      appendTaskLog(
        taskId,
        "system",
        `V2 orchestration: launched ${launchCount}/${queues.length} foreign department batches; remaining queues wait for free slots`,
      );
    }
  }

  function maybeNotifyAllSubtasksComplete(parentTaskId: string): void {
    const allOpenSubtasks = db
      .prepare("SELECT * FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled') ORDER BY created_at")
      .all(parentTaskId) as unknown as SubtaskRow[];
    const remaining = db
      .prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')")
      .get(parentTaskId) as { cnt: number };

    // Check if VIDEO_FINAL_RENDER is the only incomplete subtask(s)
    if (remaining.cnt > 0) {
      const pendingRender = db
        .prepare(
          "SELECT * FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled') AND title LIKE '%[VIDEO_FINAL_RENDER]%'",
        )
        .all(parentTaskId) as unknown as SubtaskRow[];

      const nonRenderRemaining = remaining.cnt - pendingRender.length;

      if (nonRenderRemaining === 0 && pendingRender.length > 0) {
        const repair = reconcileVideoRenderDelegationState({ db, nowMs, broadcast }, pendingRender);
        if (repair.staleResetCount > 0 || repair.recoveredDoneCount > 0) {
          appendTaskLog(
            parentTaskId,
            "system",
            `VIDEO_FINAL_RENDER delegation state repaired (stale_reset=${repair.staleResetCount}, recovered_done=${repair.recoveredDoneCount})`,
          );
        }

        const refreshedPendingRender = db
          .prepare(
            "SELECT * FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled') AND title LIKE '%[VIDEO_FINAL_RENDER]%'",
          )
          .all(parentTaskId) as unknown as SubtaskRow[];
        const undelegated = refreshedPendingRender.filter((s) => !String(s.delegated_task_id ?? "").trim());
        if (undelegated.length > 0) {
          // Unblock render subtasks so delegation can proceed
          for (const sub of undelegated) {
            if (sub.status === "blocked") {
              db.prepare("UPDATE subtasks SET status = 'pending', blocked_reason = NULL WHERE id = ?").run(sub.id);
              broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
            }
          }
          appendTaskLog(
            parentTaskId,
            "system",
            "All non-render subtasks completed. Unblocked and triggering VIDEO_FINAL_RENDER delegation.",
          );
          processSubtaskDelegations(parentTaskId, { includeRender: true });
          return; // Not all done yet — don't call finishReview
        }
      }
    }

    const parentTask = db
      .prepare(
        `
        SELECT title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id,
               orchestration_version, orchestration_stage
        FROM tasks
        WHERE id = ?
      `,
      )
      .get(parentTaskId) as
      | {
          title: string;
          description: string | null;
          status: string;
          workflow_pack_key: string | null;
          source_task_id: string | null;
          assigned_agent_id: string | null;
          department_id: string | null;
          orchestration_version: number | null;
          orchestration_stage: string | null;
        }
      | undefined;
    if (!parentTask) return;
    const isV2 = isTaskOrchestrationV2(parentTask);
    const orchestrationStage = getTaskOrchestrationStage(parentTask);

    if (isV2 && !parentTask.source_task_id) {
      const foreignOpen = allOpenSubtasks.filter((subtask) => inferOrchestrationPhaseFromSubtask(subtask) === "foreign_collab");
      const ownerIntegrateOpen = allOpenSubtasks.filter(
        (subtask) => inferOrchestrationPhaseFromSubtask(subtask) === "owner_integrate",
      );
      const finalizeOpen = allOpenSubtasks.filter((subtask) => inferOrchestrationPhaseFromSubtask(subtask) === "finalize");

      if (orchestrationStage === "foreign_collab") {
        if (foreignOpen.length === 0) {
          updateTaskOrchestrationStage(parentTaskId, "owner_integrate", "collaborating");
          resumeOwnerIntegrationTask(parentTaskId);
        }
        return;
      }

      if (orchestrationStage === "finalize" && remaining.cnt === 0) {
        updateTaskOrchestrationStage(parentTaskId, "review", "review");
        appendTaskLog(parentTaskId, "system", "V2 orchestration: finalize complete, entering review");
        const yolo = readYoloModeEnabled(db);
        setTimeout(
          () =>
            finishReview(parentTaskId, parentTask.title, {
              bypassProjectDecisionGate: yolo,
              trigger: "v2_finalize_complete",
            }),
          1200,
        );
        return;
      }

      if (orchestrationStage === "owner_integrate" && remaining.cnt > 0) {
        const unresolvedNonFinalize = ownerIntegrateOpen.length + foreignOpen.length;
        if (unresolvedNonFinalize === 0 && finalizeOpen.length > 0) {
          updateTaskOrchestrationStage(parentTaskId, "finalize", "collaborating");
          appendTaskLog(parentTaskId, "system", "V2 orchestration: owner integration complete, dispatching finalize phase");
          processSubtaskDelegations(parentTaskId, { includeRender: true });
        }
        return;
      }
    }

    // Auto-resume retry should continue even after completion notice was already sent.
    if (remaining.cnt === 0) {
      if (
        !(
          parentTask.status === "pending" &&
          parentTask.workflow_pack_key === "video_preprod" &&
          !parentTask.source_task_id &&
          parentTask.assigned_agent_id
        )
      ) {
        clearAutoResumeRetry(parentTaskId);
      } else {
        const recentLogs = db
          .prepare(
            `
            SELECT message
            FROM task_logs
            WHERE task_id = ?
              AND kind = 'system'
            ORDER BY created_at DESC
            LIMIT 12
          `,
          )
          .all(parentTaskId) as Array<{ message: string | null }>;
        const heldForRenderOrdering = recentLogs.some((row) =>
          String(row.message ?? "").includes(
            "Video render hold: waiting for documentation/planning completion before final render",
          ),
        );
        if (!heldForRenderOrdering) {
          clearAutoResumeRetry(parentTaskId);
        } else {
          const assignedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(parentTask.assigned_agent_id) as
            | AgentRow
            | undefined;
          if (!assignedAgent) {
            appendTaskLog(parentTaskId, "system", "Auto-resume skipped: assigned agent not found");
            clearAutoResumeRetry(parentTaskId);
          } else if (activeProcesses.has(parentTaskId)) {
            appendTaskLog(parentTaskId, "system", "Auto-resume skipped: task process already active");
            clearAutoResumeRetry(parentTaskId);
          } else if (
            assignedAgent.status === "working" &&
            assignedAgent.current_task_id &&
            assignedAgent.current_task_id !== parentTaskId &&
            activeProcesses.has(assignedAgent.current_task_id)
          ) {
            appendTaskLog(
              parentTaskId,
              "system",
              `Auto-resume deferred: assigned agent busy on ${assignedAgent.current_task_id}`,
            );
            scheduleAutoResumeRetry(parentTaskId, `agent_busy:${assignedAgent.current_task_id}`);
          } else {
            const deptId = assignedAgent.department_id ?? parentTask.department_id ?? null;
            const deptName = deptId ? getDeptName(deptId, parentTask.workflow_pack_key ?? null) : "Unassigned";
            appendTaskLog(
              parentTaskId,
              "system",
              "Video render hold cleared: all subtasks completed. Auto-resuming final render run.",
            );
            startTaskExecutionForAgent(parentTaskId, assignedAgent, deptId, deptName);
            clearAutoResumeRetry(parentTaskId);
          }
        }
      }
    }

    if (remaining.cnt !== 0 || subtaskDelegationCompletionNoticeSent.has(parentTaskId)) return;

    const lang = resolveLang(parentTask.description ?? parentTask.title);
    subtaskDelegationCompletionNoticeSent.add(parentTaskId);
    const subtaskProgressSummary = formatTaskSubtaskProgressSummary(parentTaskId, lang);
    const progressSuffix = subtaskProgressSummary
      ? `\n${pickL(l(["보완/협업 완료 현황"], ["Remediation/Collaboration completion"], ["補完/協業 完了状況"], ["整改/协作完成情况"]), lang)}\n${subtaskProgressSummary}`
      : "";
    notifyCeo(
      pickL(
        l(
          [`'${parentTask.title}' 의 모든 서브태스크(부서간 협업 포함)가 완료되었습니다. ✅${progressSuffix}`],
          [
            `All subtasks for '${parentTask.title}' (including cross-department collaboration) are complete. ✅${progressSuffix}`,
          ],
          [`'${parentTask.title}' の全サブタスク（部門間協業含む）が完了しました。✅${progressSuffix}`],
          [`'${parentTask.title}'的全部 SubTask（含跨部门协作）已完成。✅${progressSuffix}`],
        ),
        lang,
      ),
      parentTaskId,
    );
    if (parentTask.status === "review") {
      const yolo = readYoloModeEnabled(db);
      setTimeout(
        () =>
          finishReview(parentTaskId, parentTask.title, {
            bypassProjectDecisionGate: yolo,
            trigger: "subtask_completion",
          }),
        1200,
      );
    }
  }

  function finalizeDelegatedSubtasks(delegatedTaskId: string, subtaskIds: string[], exitCode: number): void {
    if (subtaskIds.length === 0) return;

    const pausedRun =
      exitCode !== 0 &&
      stopRequestedTasks.has(delegatedTaskId) &&
      stopRequestModeByTask.get(delegatedTaskId) === "pause";
    if (pausedRun) {
      appendTaskLog(
        delegatedTaskId,
        "system",
        "Delegated subtask finalization deferred (pause requested, waiting for resume)",
      );
      handleTaskRunComplete(delegatedTaskId, exitCode);
      return;
    }

    delegatedTaskToSubtask.delete(delegatedTaskId);
    handleTaskRunComplete(delegatedTaskId, exitCode);

    const lang = getPreferredLanguage();
    const blockedReason = pickL(
      l(["위임 작업 실패"], ["Delegated task failed"], ["委任タスク失敗"], ["委派任务失败"]),
      lang,
    );
    const doneAt = nowMs();
    const touchedParentTaskIds = new Set<string>();

    for (const subtaskId of subtaskIds) {
      const sub = db.prepare("SELECT task_id FROM subtasks WHERE id = ?").get(subtaskId) as
        | { task_id: string }
        | undefined;
      if (sub?.task_id) touchedParentTaskIds.add(sub.task_id);
      if (exitCode === 0) {
        db.prepare("UPDATE subtasks SET status = 'done', completed_at = ?, blocked_reason = NULL WHERE id = ?").run(
          doneAt,
          subtaskId,
        );
      } else {
        db.prepare("UPDATE subtasks SET status = 'blocked', blocked_reason = ? WHERE id = ?").run(
          blockedReason,
          subtaskId,
        );
      }
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtaskId));
    }

    if (exitCode === 0) {
      for (const parentTaskId of touchedParentTaskIds) {
        maybeNotifyAllSubtasksComplete(parentTaskId);
      }
    }
  }

  const { delegateSubtaskBatch } = createSubtaskDelegationBatch({
    db,
    l,
    pickL,
    resolveLang,
    getDeptName,
    getAgentDisplayName,
    findTeamLeader,
    findBestSubordinate,
    nowMs,
    broadcast,
    notifyCeo,
    sendAgentMessage,
    appendTaskLog,
    recordTaskCreationAudit,
    resolveProjectPath,
    createWorktree,
    logsDir,
    ensureTaskExecutionSession,
    ensureClaudeMd,
    getProviderModelConfig,
    spawnCliAgent,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    startProgressTimer,
    subtaskDelegationCallbacks,
    delegatedTaskToSubtask,
    maybeNotifyAllSubtasksComplete,
    finalizeDelegatedSubtasks,
    buildSubtaskDelegationPrompt,
  });

  return {
    formatTaskSubtaskProgressSummary,
    hasOpenForeignSubtasks,
    processSubtaskDelegations,
    maybeNotifyAllSubtasksComplete,
  };
}
