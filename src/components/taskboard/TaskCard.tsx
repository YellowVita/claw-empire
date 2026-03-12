import { useState } from "react";
import type { Agent, Department, SubTask, Task, TaskStatus } from "../../types";
import { useI18n } from "../../i18n";
import AgentAvatar from "../AgentAvatar";
import AgentSelect from "../AgentSelect";
import DiffModal from "./DiffModal";
import {
  developmentHandoffBadgeClass,
  developmentHandoffLabel,
  getTaskTypeBadge,
  isHideableStatus,
  priorityIcon,
  priorityLabel,
  STATUS_OPTIONS,
  taskStatusLabel,
  timeAgo,
} from "./constants";
import {
  getSubtaskDisplayState,
  summarizeBlockedSubtasks,
  getBlockedSubtaskTone,
  type BlockedSubtaskDisplayState,
} from "./subtask-display";

interface TaskCardProps {
  task: Task;
  agents: Agent[];
  departments: Department[];
  taskSubtasks: SubTask[];
  isHiddenTask?: boolean;
  onUpdateTask: (id: string, data: Partial<Task>) => void;
  onDeleteTask: (id: string) => void;
  onAssignTask: (taskId: string, agentId: string) => void;
  onRunTask: (id: string) => void;
  onStopTask: (id: string) => void;
  onPauseTask?: (id: string) => void;
  onResumeTask?: (id: string) => void;
  onOpenTerminal?: (taskId: string) => void;
  onOpenMeetingMinutes?: (taskId: string) => void;
  onRunSubtaskAction: (subtaskId: string, action: "retry" | "move_to_owner" | "mark_done") => void | Promise<void>;
  onMergeTask?: (id: string) => void;
  onDiscardTask?: (id: string) => void;
  onHideTask?: (id: string) => void;
  onUnhideTask?: (id: string) => void;
}

const SUBTASK_STATUS_ICON: Record<string, string> = {
  pending: "⌛",
  in_progress: "🔨",
  done: "✅",
  blocked: "🚫",
};

function blockedSubtaskLabel(kind: BlockedSubtaskDisplayState, t: any): string {
  if (kind === "owner_gate_waiting") return t({ ko: "원부서 정리 대기", en: "Waiting on owner team" });
  if (kind === "collaboration_waiting") return t({ ko: "협업 대기", en: "Waiting for collaboration" });
  if (kind === "delegation_retry_needed") return t({ ko: "위임 재시도 필요", en: "Delegation retry needed" });
  return t({ ko: "차단", en: "Blocked" });
}

function blockedSubtaskBadgeClass(kind: BlockedSubtaskDisplayState): string {
  const tone = getBlockedSubtaskTone(kind);
  if (tone === "waiting") return "border border-sky-500/30 bg-sky-500/10 text-sky-200";
  if (tone === "retry") return "border border-amber-500/30 bg-amber-500/10 text-amber-200";
  if (tone === "blocked") return "border border-rose-500/30 bg-rose-500/10 text-rose-200";
  return "border border-red-500/30 bg-red-500/10 text-red-200";
}

export default function TaskCard({
  task,
  agents,
  departments,
  taskSubtasks,
  isHiddenTask,
  onUpdateTask,
  onDeleteTask,
  onAssignTask,
  onRunTask,
  onStopTask,
  onPauseTask,
  onResumeTask,
  onOpenTerminal,
  onOpenMeetingMinutes,
  onRunSubtaskAction,
  onMergeTask,
  onDiscardTask,
  onHideTask,
  onUnhideTask,
}: TaskCardProps) {
  void onMergeTask;
  void onDiscardTask;
  const { t, locale: localeTag, language: locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showSubtasks, setShowSubtasks] = useState(false);
  const [agentWarning, setAgentWarning] = useState(false);
  const [subtaskActionBusyId, setSubtaskActionBusyId] = useState<string | null>(null);

  const assignedAgent = task.assigned_agent ?? agents.find((agent) => agent.id === task.assigned_agent_id);
  const fallbackAssignedName =
    (locale === "ko" ? task.agent_name_ko || task.agent_name : task.agent_name || task.agent_name_ko) ||
    task.assigned_agent_id;
  const assignedDisplayName = assignedAgent ? (locale === "ko" ? assignedAgent.name_ko : assignedAgent.name) : null;
  const assignedLabel = assignedDisplayName || fallbackAssignedName || null;
  const department = departments.find((d) => d.id === task.department_id);
  const typeBadge = getTaskTypeBadge(task.task_type, t);
  const developmentHandoff =
    task.workflow_pack_key === "development" && task.development_handoff ? task.development_handoff : null;

  const canRun = task.status === "planned" || task.status === "inbox";
  const canStop = task.status === "in_progress";
  const canPause = task.status === "in_progress" && !!onPauseTask;
  const canResume = (task.status === "pending" || task.status === "cancelled") && !!onResumeTask;
  const canDelete = task.status !== "in_progress";
  const canHideTask = isHideableStatus(task.status);
  const blockedSummary = summarizeBlockedSubtasks(task, taskSubtasks);
  const blockedSummaryItems = [
    blockedSummary.ownerGateWaiting > 0
      ? {
          key: "owner",
          label: blockedSubtaskLabel("owner_gate_waiting", t),
          count: blockedSummary.ownerGateWaiting,
          className: blockedSubtaskBadgeClass("owner_gate_waiting"),
        }
      : null,
    blockedSummary.collaborationWaiting > 0
      ? {
          key: "collab",
          label: blockedSubtaskLabel("collaboration_waiting", t),
          count: blockedSummary.collaborationWaiting,
          className: blockedSubtaskBadgeClass("collaboration_waiting"),
        }
      : null,
    blockedSummary.delegationRetryNeeded > 0
      ? {
          key: "retry",
          label: blockedSubtaskLabel("delegation_retry_needed", t),
          count: blockedSummary.delegationRetryNeeded,
          className: blockedSubtaskBadgeClass("delegation_retry_needed"),
        }
      : null,
    blockedSummary.genericBlocked > 0
      ? {
          key: "blocked",
          label: blockedSubtaskLabel("generic_blocked", t),
          count: blockedSummary.genericBlocked,
          className: blockedSubtaskBadgeClass("generic_blocked"),
        }
      : null,
  ].filter(Boolean) as Array<{ key: string; label: string; count: number; className: string }>;

  return (
    <div
      className={`group relative rounded-xl border p-3.5 shadow-sm transition hover:shadow-md ${
        isHiddenTask
          ? "border-cyan-700/80 bg-slate-800/80 hover:border-cyan-600"
          : "border-slate-800/60 bg-slate-900/60 hover:border-slate-700"
      }`}
    >
      {/* Task Lineage Strip (P1) & Heartbeat (P3) */}
      <div className="mb-2 flex items-center justify-between border-b border-slate-800 pb-2">
        {task.source_task_id ? (
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
            <span className="opacity-70">🔗 Parent Task:</span>
            <span className="font-mono text-cyan-400/80">{task.source_task_id.slice(0, 8)}</span>
          </div>
        ) : <div />}
        
        {new Date().getTime() - new Date(task.updated_at).getTime() < 5 * 60 * 1000 && (
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
            </span>
            <span className="text-[9px] font-medium text-emerald-400 opacity-80 uppercase tracking-tighter">Active</span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex-1 text-left text-sm font-semibold leading-snug text-white"
          >
            {task.title}
          </button>
          <span
            className="flex-shrink-0 text-base"
            title={`${t({ ko: "우선순위", en: "Priority" })}: ${priorityLabel(task.priority, t)}`}
          >
            {priorityIcon(task.priority)}
          </span>
        </div>

        {task.description && (
          <p className={`text-xs leading-relaxed text-slate-400 ${expanded ? "" : "line-clamp-2"}`}>
            {task.description}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeBadge.color}`}>{typeBadge.label}</span>
          {isHiddenTask && (
            <span className="rounded-full bg-cyan-900/60 px-2 py-0.5 text-xs text-cyan-200">
              🙈 {t({ ko: "숨김", en: "Hidden" })}
            </span>
          )}
          {department && (
            <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
              {department.icon} {locale === "ko" ? department.name_ko : department.name}
            </span>
          )}
          {developmentHandoff && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${developmentHandoffBadgeClass(developmentHandoff)}`}>
              {developmentHandoffLabel(developmentHandoff.state, t)}
            </span>
          )}
        </div>

        {developmentHandoff && (
          <div className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-[11px] font-medium text-slate-200">
                {developmentHandoff.summary || t({ ko: "개발 인수인계 상태가 갱신되었습니다", en: "Development handoff updated" })}
              </p>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
                {developmentHandoff.pr_gate_status === "blocked" ? "pr blocked" : developmentHandoff.pending_retry ? "retry" : ""}
              </span>
            </div>
          </div>
        )}

        <div>
          <select
            value={task.status}
            onChange={(event) => onUpdateTask(task.id, { status: event.target.value as TaskStatus })}
            className="w-full rounded-lg border border-slate-600 bg-slate-700 px-2 py-1 text-xs text-white outline-none transition focus:border-blue-500"
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {taskStatusLabel(status as TaskStatus, t)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {assignedAgent && assignedLabel ? (
              <>
                <AgentAvatar agent={assignedAgent} agents={agents} size={20} />
                <span className="text-xs text-slate-300">{assignedLabel}</span>
              </>
            ) : assignedLabel ? (
              <span className="text-xs text-slate-300">{assignedLabel}</span>
            ) : (
              <span className="text-xs text-slate-500">{t({ ko: "미배정", en: "Unassigned" })}</span>
            )}
          </div>
          <span className="text-xs text-slate-500">{timeAgo(task.created_at, localeTag)}</span>
        </div>

        <div className={`rounded-lg transition-all ${agentWarning ? "ring-2 ring-red-500 animate-[shake_0.4s_ease-in-out]" : ""}`}>
          <AgentSelect
            agents={agents}
            departments={departments}
            value={task.assigned_agent_id ?? ""}
            onChange={(agentId) => {
              setAgentWarning(false);
              if (agentId) onAssignTask(task.id, agentId);
              else onUpdateTask(task.id, { assigned_agent_id: null });
            }}
          />
        </div>

        {(task.subtask_total ?? 0) > 0 && (
          <div>
            <button onClick={() => setShowSubtasks((v) => !v)} className="mb-1.5 flex w-full items-center gap-2 text-left">
              <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full transition-all"
                  style={{ width: `${Math.round(((task.subtask_done ?? 0) / (task.subtask_total ?? 1)) * 100)}%` }}
                />
              </div>
              <span className="text-xs text-slate-400 whitespace-nowrap">
                {task.subtask_done ?? 0}/{task.subtask_total ?? 0}
              </span>
              <span className="text-xs text-slate-500">{showSubtasks ? "▲" : "▼"}</span>
            </button>
            {blockedSummaryItems.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {blockedSummaryItems.map((item) => (
                  <span key={item.key} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${item.className}`}>
                    {item.label} {item.count}
                  </span>
                ))}
              </div>
            )}
            {showSubtasks && taskSubtasks.length > 0 && (
              <div className="space-y-1 pl-1">
                {blockedSummary.ownerGateWaiting > 0 && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-100 mb-1.5">
                    {t({
                      ko: "외부 부서 서브태스크는 원부서 선행 작업 완료 후 자동 위임됩니다.",
                      en: "External subtasks will be delegated automatically after owner-team prep is finished.",
                    })}
                  </div>
                )}
                {taskSubtasks.map((subtask) => {
                  const targetDepartment = subtask.target_department_id
                    ? departments.find((d) => d.id === subtask.target_department_id)
                    : null;
                  const displayState = getSubtaskDisplayState(subtask, task, taskSubtasks);
                  const waitingHint =
                    displayState.kind === "collaboration_waiting"
                      ? t({ ko: "자동 위임 예정", en: "Auto delegation pending" })
                      : displayState.kind === "owner_gate_waiting"
                        ? t({ ko: "원부서 선행 작업 대기", en: "Waiting on owner-team prep" })
                        : null;
                  return (
                    <div key={subtask.id} className="rounded-md border border-slate-700/70 bg-slate-900/60 px-2 py-1.5">
                      <div className="flex items-center gap-1.5 text-xs">
                        <span>{SUBTASK_STATUS_ICON[subtask.status] || "⌛"}</span>
                        <span className={`flex-1 truncate ${subtask.status === "done" ? "line-through text-slate-500" : "text-slate-300"}`}>
                          {subtask.title}
                        </span>
                        {targetDepartment && (
                          <span
                            className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium"
                            style={{ backgroundColor: targetDepartment.color + "30", color: targetDepartment.color }}
                          >
                            {targetDepartment.icon} {locale === "ko" ? targetDepartment.name_ko : targetDepartment.name}
                          </span>
                        )}
                        {subtask.delegated_task_id && subtask.status !== "done" && (
                          <span className="text-blue-400 shrink-0" title={t({ ko: "위임됨", en: "Delegated" }) ?? undefined}>
                            🔗
                          </span>
                        )}
                      </div>
                      {subtask.status === "blocked" && (
                        <div className="mt-1 flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${blockedSubtaskBadgeClass(displayState.kind === "default" ? "generic_blocked" : displayState.kind)}`}>
                              {blockedSubtaskLabel(displayState.kind === "default" ? "generic_blocked" : displayState.kind, t)}
                            </span>
                            {waitingHint && <span className="text-[10px] text-slate-400">{waitingHint}</span>}
                          </div>
                          <span className={`text-[10px] ${displayState.isWaiting ? "text-slate-400" : "text-red-300"}`} title={subtask.blocked_reason ?? undefined}>
                            {subtask.blocked_reason}
                          </span>
                          <div className="flex flex-wrap gap-1">
                            <button
                              disabled={subtaskActionBusyId === subtask.id}
                              onClick={async () => {
                                try {
                                  setSubtaskActionBusyId(subtask.id);
                                  await onRunSubtaskAction(subtask.id, "retry");
                                } finally {
                                  setSubtaskActionBusyId(null);
                                }
                              }}
                              className="rounded border border-amber-500/50 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-500/10"
                            >
                              {t({ ko: "재시도", en: "Retry" })}
                            </button>
                            <button
                                disabled={subtaskActionBusyId === subtask.id}
                                onClick={async () => {
                                  try {
                                    setSubtaskActionBusyId(subtask.id);
                                    await onRunSubtaskAction(subtask.id, "move_to_owner");
                                  } finally {
                                    setSubtaskActionBusyId(null);
                                  }
                                }}
                                className="rounded border border-cyan-500/50 px-1.5 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10"
                              >
                                {t({ ko: "원부서 처리", en: "Move to Owner" })}
                              </button>
                            <button
                              disabled={subtaskActionBusyId === subtask.id}
                              onClick={async () => {
                                try {
                                  setSubtaskActionBusyId(subtask.id);
                                  await onRunSubtaskAction(subtask.id, "mark_done");
                                } finally {
                                  setSubtaskActionBusyId(null);
                                }
                              }}
                              className="rounded border border-emerald-500/50 px-1.5 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/10"
                            >
                              {t({ ko: "완료 처리", en: "Mark Done" })}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Actions Section (P2 - Reorganized) */}
        <div className="flex items-center justify-between border-t border-slate-800 pt-3">
          <div className="flex items-center gap-1.5">
            {canRun && (
              <button
                onClick={() => {
                  if (!task.assigned_agent_id) {
                    setAgentWarning(true);
                    setTimeout(() => setAgentWarning(false), 3000);
                    return;
                  }
                  onRunTask(task.id);
                }}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 shadow-sm"
              >
                <span>▶️</span> {t({ ko: "시작", en: "Run" })}
              </button>
            )}
            {canStop && (
              <button
                onClick={() => {
                  if (confirm(t({ ko: "작업을 중지할까요?", en: "Stop task?" }))) onStopTask(task.id);
                }}
                className="flex items-center gap-1.5 rounded-lg bg-red-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 shadow-sm"
              >
                <span>⏹️</span> {t({ ko: "중지", en: "Stop" })}
              </button>
            )}
            {canResume && (
              <button
                onClick={() => onResumeTask!(task.id)}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm"
              >
                <span>⏯️</span> {t({ ko: "재개", en: "Resume" })}
              </button>
            )}
            {onOpenTerminal && (
              <button
                onClick={() => onOpenTerminal(task.id)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
              >
                <span>💻</span> {t({ ko: "터미널", en: "Terminal" })}
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition">
            {onOpenMeetingMinutes && (
              <button
                onClick={() => onOpenMeetingMinutes(task.id)}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                title={t({ ko: "회의록", en: "Minutes" })}
              >
                <span>📝</span>
              </button>
            )}
            {task.workflow_pack_key === "development" && (
              <button
                onClick={() => setShowDiff(true)}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                title={t({ ko: "변경 사항", en: "Diff" })}
              >
                <span>🔍</span>
              </button>
            )}
            {canHideTask && onHideTask && (
              <button
                onClick={() => (isHiddenTask ? onUnhideTask?.(task.id) : onHideTask(task.id))}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                title={isHiddenTask ? "Show" : "Hide"}
              >
                <span>{isHiddenTask ? "👁️" : "🙈"}</span>
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => {
                  if (confirm(t({ ko: "삭제할까요?", en: "Delete?" }))) onDeleteTask(task.id);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:bg-rose-900/30 hover:text-rose-400"
                title={t({ ko: "삭제", en: "Delete" })}
              >
                <span>🗑️</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {showDiff && <DiffModal taskId={task.id} onClose={() => setShowDiff(false)} />}
    </div>
  );
}
