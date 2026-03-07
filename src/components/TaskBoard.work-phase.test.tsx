import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import TaskBoard from "./TaskBoard";
import type { Task } from "../types";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Task",
    description: overrides.description ?? null,
    department_id: overrides.department_id ?? null,
    assigned_agent_id: overrides.assigned_agent_id ?? null,
    project_id: overrides.project_id ?? null,
    status: overrides.status ?? "inbox",
    priority: overrides.priority ?? 1,
    task_type: overrides.task_type ?? "general",
    work_phase: overrides.work_phase ?? null,
    workflow_pack_key: overrides.workflow_pack_key ?? "development",
    workflow_meta_json: overrides.workflow_meta_json ?? null,
    output_format: overrides.output_format ?? null,
    project_path: overrides.project_path ?? null,
    result: overrides.result ?? null,
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
    created_at: overrides.created_at ?? 1,
    updated_at: overrides.updated_at ?? 1,
    source_task_id: overrides.source_task_id ?? null,
    subtask_total: overrides.subtask_total ?? 0,
    subtask_done: overrides.subtask_done ?? 0,
    hidden: overrides.hidden ?? 0,
  };
}

describe("TaskBoard work phase filter", () => {
  it("filters tasks by selected work phase", async () => {
    const user = userEvent.setup();

    render(
      <TaskBoard
        tasks={[
          makeTask({ id: "task-api", title: "API endpoint cleanup", work_phase: "api_work" }),
          makeTask({ id: "task-debug", title: "Trace flaky retry", work_phase: "debugging" }),
        ]}
        agents={[]}
        departments={[]}
        subtasks={[]}
        onCreateTask={() => {}}
        onUpdateTask={() => {}}
        onDeleteTask={() => {}}
        onAssignTask={() => {}}
        onRunTask={() => {}}
        onStopTask={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Work Phase", { selector: "#task-work-phase-filter" }), "debugging");

    expect(screen.getByText("Trace flaky retry")).toBeInTheDocument();
    expect(screen.queryByText("API endpoint cleanup")).not.toBeInTheDocument();
  });
});
