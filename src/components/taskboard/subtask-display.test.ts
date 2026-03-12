import { describe, expect, it } from "vitest";

import type { SubTask, Task } from "../../types";
import { getSubtaskDisplayState, summarizeBlockedSubtasks } from "./subtask-display";

const baseTask: Task = {
  id: "task-1",
  title: "Parent task",
  description: null,
  status: "planned",
  priority: 3,
  department_id: "dev",
  assigned_agent_id: null,
  task_type: "general",
  project_path: null,
  result: null,
  started_at: null,
  completed_at: null,
  created_at: 1,
  updated_at: 1,
};

function createSubtask(overrides: Partial<SubTask>): SubTask {
  return {
    id: "subtask",
    task_id: "task-1",
    title: "Subtask",
    description: null,
    status: "blocked",
    assigned_agent_id: null,
    blocked_reason: "blocked",
    cli_tool_use_id: null,
    target_department_id: null,
    delegated_task_id: null,
    created_at: 1,
    completed_at: null,
    ...overrides,
  };
}

describe("subtask display state", () => {
  it("classifies blocked foreign subtasks with owner-side work remaining as owner-gate waiting", () => {
    const ownerOpen = createSubtask({ id: "owner-open", status: "pending", target_department_id: "dev", blocked_reason: null });
    const foreignBlocked = createSubtask({ id: "foreign", target_department_id: "qa" });

    const state = getSubtaskDisplayState(foreignBlocked, baseTask, [ownerOpen, foreignBlocked]);

    expect(state.kind).toBe("owner_gate_waiting");
    expect(state.isWaiting).toBe(true);
  });

  it("classifies blocked foreign subtasks without owner-side work as collaboration waiting", () => {
    const foreignBlocked = createSubtask({ id: "foreign", target_department_id: "qa" });

    const state = getSubtaskDisplayState(foreignBlocked, baseTask, [foreignBlocked]);

    expect(state.kind).toBe("collaboration_waiting");
    expect(state.isWaiting).toBe(true);
  });

  it("classifies delegated blocked subtasks as needing retry", () => {
    const delegatedBlocked = createSubtask({ delegated_task_id: "delegated-1", target_department_id: "qa" });

    const state = getSubtaskDisplayState(delegatedBlocked, baseTask, [delegatedBlocked]);

    expect(state.kind).toBe("delegation_retry_needed");
    expect(state.isWaiting).toBe(false);
  });

  it("keeps generic blocked subtasks as generic blocked", () => {
    const genericBlocked = createSubtask({});

    const state = getSubtaskDisplayState(genericBlocked, baseTask, [genericBlocked]);

    expect(state.kind).toBe("generic_blocked");
    expect(state.isWaiting).toBe(false);
  });

  it("summarizes blocked subtasks by display category", () => {
    const subtasks = [
      createSubtask({ id: "owner-open", status: "pending", target_department_id: "dev", blocked_reason: null }),
      createSubtask({ id: "owner-gate", target_department_id: "qa" }),
      createSubtask({ id: "collab", target_department_id: "design" }),
      createSubtask({ id: "retry", target_department_id: "qa", delegated_task_id: "delegated-1" }),
      createSubtask({ id: "generic", target_department_id: null }),
    ];

    const summary = summarizeBlockedSubtasks(baseTask, subtasks);

    expect(summary).toEqual({
      ownerGateWaiting: 2,
      collaborationWaiting: 0,
      delegationRetryNeeded: 1,
      genericBlocked: 1,
    });
  });
});
