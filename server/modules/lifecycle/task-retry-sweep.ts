import type { DatabaseSync } from "node:sqlite";

import { getRetryAgentById } from "../../db/queries/agent-queries.ts";
import { getRetryTaskById } from "../../db/queries/task-queries.ts";
import {
  deleteTaskRetryQueueRow,
  listDueTaskRetryQueueRows,
  readTaskExecutionPolicy,
  rescheduleBusyTaskRetryQueueRow,
} from "../workflow/orchestration/task-execution-policy.ts";
import { recordTaskExecutionEvent } from "../workflow/orchestration/task-execution-events.ts";

export interface TaskRetrySweepDeps {
  db: DatabaseSync;
  activeProcesses: Map<string, unknown>;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  nowMs: () => number;
  startTaskExecutionForAgent: (
    taskId: string,
    agent: {
      id: string;
      name: string;
      department_id: string | null;
      department_name: string;
    },
    departmentId: string | null,
    departmentName: string,
  ) => void;
}

export function sweepTaskRetryQueue({
  db,
  activeProcesses,
  appendTaskLog,
  nowMs,
  startTaskExecutionForAgent,
}: TaskRetrySweepDeps): void {
  const policy = readTaskExecutionPolicy(db as any);
  if (!policy.enabled) return;

  const dueRows = listDueTaskRetryQueueRows(db as any, nowMs(), 20);
  for (const row of dueRows) {
    const task = getRetryTaskById(db, row.task_id);
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

    const agent = getRetryAgentById(db, task.assigned_agent_id);
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
