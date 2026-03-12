import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../i18n";
import type { Agent, Department, SubTask, Task } from "../../types";
import TaskCard from "./TaskCard";

const baseTask: Task = {
  id: "task-1",
  title: "Parent task",
  description: "desc",
  status: "planned",
  priority: 3,
  department_id: "dev",
  assigned_agent_id: "dev-1",
  created_at: 1,
  updated_at: 1,
  started_at: null,
  completed_at: null,
  task_type: "general",
  hidden: 0,
  workflow_pack_key: "development",
  development_handoff: {
    state: "human_review",
    updated_at: 1,
    status_snapshot: "review",
    pending_retry: false,
    pr_gate_status: "blocked",
    pr_url: "https://github.com/acme/repo/pull/7",
    summary: "Blocked by PR feedback gate",
  },
  source_task_id: null,
  result: null,
  project_id: null,
  project_path: null,
  assigned_agent: undefined,
  agent_name: "Dev Lead",
  agent_name_ko: "개발팀장",
  subtask_total: 1,
  subtask_done: 0,
};

const agents: Agent[] = [
  {
    id: "dev-1",
    name: "Dev Lead",
    name_ko: "개발팀장",
    name_ja: "Dev Lead",
    name_zh: "Dev Lead",
    department_id: "dev",
    role: "team_leader",
    personality: null,
    status: "idle",
    current_task_id: null,
    avatar_emoji: "D",
    cli_provider: "codex",
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    cli_model: null,
    cli_reasoning_level: null,
    stats_tasks_done: 0,
    stats_xp: 0,
    created_at: 1,
  },
];

const departments: Department[] = [
  {
    id: "dev",
    name: "Development",
    name_ko: "개발팀",
    name_ja: "開発",
    name_zh: "开发",
    icon: "D",
    color: "#00f",
    description: null,
    prompt: null,
    sort_order: 1,
    created_at: 1,
  },
  {
    id: "qa",
    name: "QA",
    name_ko: "QA팀",
    name_ja: "QA",
    name_zh: "QA",
    icon: "Q",
    color: "#0f0",
    description: null,
    prompt: null,
    sort_order: 2,
    created_at: 1,
  },
];

const blockedSubtask: SubTask = {
  id: "sub-1",
  task_id: "task-1",
  title: "QA verify",
  description: null,
  status: "blocked",
  assigned_agent_id: null,
  blocked_reason: "QA 팀장 부재",
  cli_tool_use_id: null,
  target_department_id: "qa",
  delegated_task_id: null,
  created_at: 1,
  completed_at: null,
};

const ownerPrepSubtask: SubTask = {
  id: "sub-owner",
  task_id: "task-1",
  title: "기획 정리",
  description: null,
  status: "pending",
  assigned_agent_id: null,
  blocked_reason: null,
  cli_tool_use_id: null,
  target_department_id: "dev",
  delegated_task_id: null,
  created_at: 1,
  completed_at: null,
};

describe("TaskCard blocked subtask actions", () => {
  it("renders development handoff summary for development tasks", () => {
    render(
      <I18nProvider language="en">
        <TaskCard
          task={baseTask}
          agents={agents}
          departments={departments}
          taskSubtasks={[]}
          onUpdateTask={vi.fn()}
          onDeleteTask={vi.fn()}
          onAssignTask={vi.fn()}
          onRunTask={vi.fn()}
          onStopTask={vi.fn()}
          onPauseTask={vi.fn()}
          onResumeTask={vi.fn()}
          onOpenTerminal={vi.fn()}
          onOpenMeetingMinutes={vi.fn()}
          onRunSubtaskAction={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Human Review")).toBeInTheDocument();
    expect(screen.getByText("Blocked by PR feedback gate")).toBeInTheDocument();
  });

  it("renders blocked subtask action buttons and calls the handler", async () => {
    const onRunSubtaskAction = vi.fn().mockResolvedValue(undefined);

    render(
      <I18nProvider language="ko">
        <TaskCard
          task={baseTask}
          agents={agents}
          departments={departments}
          taskSubtasks={[blockedSubtask]}
          onUpdateTask={vi.fn()}
          onDeleteTask={vi.fn()}
          onAssignTask={vi.fn()}
          onRunTask={vi.fn()}
          onStopTask={vi.fn()}
          onPauseTask={vi.fn()}
          onResumeTask={vi.fn()}
          onOpenTerminal={vi.fn()}
          onOpenMeetingMinutes={vi.fn()}
          onRunSubtaskAction={onRunSubtaskAction}
        />
      </I18nProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "0/1 ▼" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "재시도" }));
    });

    expect(onRunSubtaskAction).toHaveBeenCalledWith("sub-1", "retry");
    expect(screen.getByRole("button", { name: "원부서 처리" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "완료 처리" })).toBeInTheDocument();
  });

  it("shows waiting summaries and owner-team guidance for blocked collaboration subtasks", async () => {
    render(
      <I18nProvider language="ko">
        <TaskCard
          task={{ ...baseTask, subtask_total: 2, subtask_done: 0 }}
          agents={agents}
          departments={departments}
          taskSubtasks={[ownerPrepSubtask, blockedSubtask]}
          onUpdateTask={vi.fn()}
          onDeleteTask={vi.fn()}
          onAssignTask={vi.fn()}
          onRunTask={vi.fn()}
          onStopTask={vi.fn()}
          onPauseTask={vi.fn()}
          onResumeTask={vi.fn()}
          onOpenTerminal={vi.fn()}
          onOpenMeetingMinutes={vi.fn()}
          onRunSubtaskAction={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("원부서 정리 대기 1")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "0/2 ▼" }));
    });

    expect(screen.getByText("외부 부서 서브태스크는 원부서 선행 작업 완료 후 자동 위임됩니다.")).toBeInTheDocument();
    expect(screen.getByText("원부서 정리 대기")).toBeInTheDocument();
    expect(screen.getByText("원부서 선행 작업 대기")).toBeInTheDocument();
  });
});
