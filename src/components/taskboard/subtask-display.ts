import type { SubTask, Task } from "../../types";

export type BlockedSubtaskDisplayState =
  | "owner_gate_waiting"
  | "collaboration_waiting"
  | "delegation_retry_needed"
  | "generic_blocked";

export type SubtaskDisplayState = {
  kind: BlockedSubtaskDisplayState | "default";
  isBlocked: boolean;
  isWaiting: boolean;
  showRawReasonAsPrimary: boolean;
};

export type BlockedSubtaskSummary = {
  ownerGateWaiting: number;
  collaborationWaiting: number;
  delegationRetryNeeded: number;
  genericBlocked: number;
};

function isOpenOwnerSubtask(subtask: SubTask, task: Task): boolean {
  if (subtask.status === "done") return false;
  const targetDepartmentId = subtask.target_department_id ?? null;
  return targetDepartmentId === null || targetDepartmentId === task.department_id;
}

export function getSubtaskDisplayState(subtask: SubTask, task: Task, taskSubtasks: SubTask[]): SubtaskDisplayState {
  if (subtask.status !== "blocked") {
    return {
      kind: "default",
      isBlocked: false,
      isWaiting: false,
      showRawReasonAsPrimary: false,
    };
  }

  if (subtask.target_department_id && !subtask.delegated_task_id) {
    const ownerOpenSubtasks = taskSubtasks.some((candidate) => candidate.id !== subtask.id && isOpenOwnerSubtask(candidate, task));
    if (ownerOpenSubtasks && task.status !== "review" && task.status !== "done") {
      return {
        kind: "owner_gate_waiting",
        isBlocked: true,
        isWaiting: true,
        showRawReasonAsPrimary: false,
      };
    }
    return {
      kind: "collaboration_waiting",
      isBlocked: true,
      isWaiting: true,
      showRawReasonAsPrimary: false,
    };
  }

  if (subtask.delegated_task_id) {
    return {
      kind: "delegation_retry_needed",
      isBlocked: true,
      isWaiting: false,
      showRawReasonAsPrimary: true,
    };
  }

  return {
    kind: "generic_blocked",
    isBlocked: true,
    isWaiting: false,
    showRawReasonAsPrimary: true,
  };
}

export function summarizeBlockedSubtasks(task: Task, taskSubtasks: SubTask[]): BlockedSubtaskSummary {
  const summary: BlockedSubtaskSummary = {
    ownerGateWaiting: 0,
    collaborationWaiting: 0,
    delegationRetryNeeded: 0,
    genericBlocked: 0,
  };

  for (const subtask of taskSubtasks) {
    const state = getSubtaskDisplayState(subtask, task, taskSubtasks);
    if (state.kind === "owner_gate_waiting") summary.ownerGateWaiting += 1;
    else if (state.kind === "collaboration_waiting") summary.collaborationWaiting += 1;
    else if (state.kind === "delegation_retry_needed") summary.delegationRetryNeeded += 1;
    else if (state.kind === "generic_blocked") summary.genericBlocked += 1;
  }

  return summary;
}
