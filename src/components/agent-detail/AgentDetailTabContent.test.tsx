import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Agent, Department, SubTask, Task } from "../../types";
import AgentDetailTabContent from "./AgentDetailTabContent";

const t = (messages: Record<"ko" | "en" | "ja" | "zh", string>) => messages.ko;

const agent: Agent = {
  id: "agent-1",
  name: "Clio",
  name_ko: "클리오",
  department_id: "planning",
  role: "team_leader",
  cli_provider: "codex",
  avatar_emoji: "C",
  personality: null,
  status: "idle",
  current_task_id: null,
  stats_tasks_done: 0,
  stats_xp: 0,
  created_at: 1,
};

const departments: Department[] = [
  {
    id: "planning",
    name: "Planning",
    name_ko: "기획팀",
    icon: "P",
    color: "#999",
    description: null,
    prompt: null,
    sort_order: 1,
    created_at: 1,
  },
  {
    id: "qa",
    name: "QA",
    name_ko: "QA팀",
    icon: "Q",
    color: "#0f0",
    description: null,
    prompt: null,
    sort_order: 2,
    created_at: 1,
  },
];

const task: Task = {
  id: "task-1",
  title: "Parent task",
  description: null,
  status: "planned",
  priority: 3,
  department_id: "planning",
  assigned_agent_id: "agent-1",
  task_type: "general",
  project_path: null,
  result: null,
  started_at: null,
  completed_at: null,
  created_at: 1,
  updated_at: 1,
  subtask_total: 2,
  subtask_done: 0,
};

const taskSubtasks: SubTask[] = [
  {
    id: "sub-owner",
    task_id: "task-1",
    title: "기획 정리",
    description: null,
    status: "pending",
    assigned_agent_id: null,
    blocked_reason: null,
    cli_tool_use_id: null,
    target_department_id: "planning",
    delegated_task_id: null,
    created_at: 1,
    completed_at: null,
  },
  {
    id: "sub-blocked",
    task_id: "task-1",
    title: "QA verify",
    description: null,
    status: "blocked",
    assigned_agent_id: null,
    blocked_reason: "QA 팀장 응답 대기",
    cli_tool_use_id: null,
    target_department_id: "qa",
    delegated_task_id: null,
    created_at: 1,
    completed_at: null,
  },
];

describe("AgentDetailTabContent", () => {
  it("renders the shared blocked display badge and keeps raw reason secondary", () => {
    render(
      <AgentDetailTabContent
        tab="tasks"
        t={t}
        language="ko"
        agent={agent}
        departments={departments}
        agentTasks={[task]}
        agentSubAgents={[]}
        subtasksByTask={{ [task.id]: taskSubtasks }}
        expandedTaskId={task.id}
        setExpandedTaskId={vi.fn()}
        onChat={vi.fn()}
        onAssignTask={vi.fn()}
      />,
    );

    expect(screen.getByText("원부서 정리 대기")).toBeInTheDocument();
    expect(screen.getByText("QA 팀장 응답 대기")).toBeInTheDocument();
  });
});
