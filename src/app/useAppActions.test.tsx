import { act, render } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppActions } from "./useAppActions";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import type { Agent, CliStatusMap, CompanySettings, CompanyStats, Department, Message, SubTask, Task } from "../types";

vi.mock("../api", () => ({
  sendMessage: vi.fn(),
  getMessages: vi.fn(),
  sendAnnouncement: vi.fn(),
  sendDirective: vi.fn(),
  sendDirectiveWithProject: vi.fn(),
  createTask: vi.fn(),
  getTasks: vi.fn(),
  getStats: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  getAgents: vi.fn(),
  assignTask: vi.fn(),
  runTask: vi.fn(),
  stopTask: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
  runSubtaskAction: vi.fn(),
  saveSettings: vi.fn(),
  setAutoUpdateEnabled: vi.fn(),
  saveSettingsPatch: vi.fn(),
  getDecisionInbox: vi.fn(),
  replyDecisionInbox: vi.fn(),
  getDepartments: vi.fn(),
  getCliStatus: vi.fn(),
  clearMessages: vi.fn(),
}));

type ProbeState = {
  actions: ReturnType<typeof useAppActions>;
  settings: CompanySettings;
  tasks: Task[];
  agents: Agent[];
  decisionInboxItems: DecisionInboxItem[];
  decisionInboxLoading: boolean;
  showDecisionInbox: boolean;
  scheduleLiveSync: ReturnType<typeof vi.fn>;
};

function createAgent(id: string, name = id): Agent {
  return {
    id,
    name,
    name_ko: name,
    department_id: null,
    role: "senior",
    acts_as_planning_leader: 0,
    cli_provider: "codex",
    avatar_emoji: ":)",
    personality: null,
    status: "idle",
    current_task_id: null,
    stats_tasks_done: 0,
    stats_xp: 0,
    created_at: Date.now(),
  } as Agent;
}

function createTask(id: string): Task {
  return {
    id,
    title: `task-${id}`,
    status: "inbox",
    priority: 1,
    task_type: "general",
    created_at: Date.now(),
    updated_at: Date.now(),
    department_id: null,
    assigned_agent_id: null,
    description: "",
    project_id: null,
    project_path: null,
    result: null,
    started_at: null,
    completed_at: null,
  } as Task;
}

function createSettings(patch: Partial<CompanySettings> = {}): CompanySettings {
  return {
    companyName: "Claw Empire",
    language: "en",
    autoUpdateEnabled: false,
    autoUpdateNoticePending: false,
    officeWorkflowPack: "development",
    ...patch,
  } as CompanySettings;
}

function ActionsProbe(props: { onChange: (state: ProbeState) => void }) {
  const [settings, setSettings] = useState<CompanySettings>(createSettings());
  const [agents, setAgents] = useState<Agent[]>([createAgent("agent-1")]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [subtasks, setSubtasks] = useState<SubTask[]>([]);
  const [stats, setStats] = useState<CompanyStats | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [unreadAgentIds, setUnreadAgentIds] = useState<Set<string>>(new Set());
  const [showDecisionInbox, setShowDecisionInbox] = useState(false);
  const [decisionInboxLoading, setDecisionInboxLoading] = useState(false);
  const [decisionInboxItems, setDecisionInboxItems] = useState<DecisionInboxItem[]>([]);
  const [decisionReplyBusyKey, setDecisionReplyBusyKey] = useState<string | null>(null);
  const [cliStatus, setCliStatus] = useState<CliStatusMap | null>(null);
  const scheduleLiveSyncRef = useRef(vi.fn());
  const scheduleLiveSync = scheduleLiveSyncRef.current;

  const actions = useAppActions({
    agents,
    settings,
    scheduleLiveSync,
    setSettings,
    setAgents,
    setDepartments,
    setTasks,
    setSubtasks,
    setStats,
    setMessages,
    setChatAgent,
    setShowChat,
    setUnreadAgentIds,
    setShowDecisionInbox,
    setDecisionInboxLoading,
    setDecisionInboxItems,
    setDecisionReplyBusyKey,
    setCliStatus,
  });

  useEffect(() => {
    props.onChange({
      actions,
      settings,
      tasks,
      agents,
      decisionInboxItems,
      decisionInboxLoading,
      showDecisionInbox,
      scheduleLiveSync,
    });
  }, [
    actions,
    agents,
    decisionInboxItems,
    decisionInboxLoading,
    props,
    scheduleLiveSync,
    settings,
    showDecisionInbox,
    tasks,
  ]);

  return (
    <div
      data-chat-agent={chatAgent?.id ?? ""}
      data-show-chat={showChat}
      data-messages={messages.length}
      data-departments={departments.length}
      data-stats={stats ? 1 : 0}
      data-unread={unreadAgentIds.size}
      data-busy={decisionReplyBusyKey ?? ""}
      data-cli={cliStatus ? 1 : 0}
      data-subtasks={subtasks.length}
    />
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useAppActions", () => {
  let api: typeof import("../api");
  let latest: ProbeState | null = null;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    latest = null;
    api = await import("../api");
    vi.spyOn(window, "alert").mockImplementation(() => {});
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(key);
        }),
        clear: vi.fn(() => {
          storage.clear();
        }),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderProbe() {
    render(<ActionsProbe onChange={(state) => void (latest = state)} />);
    expect(latest).not.toBeNull();
    return latest!;
  }

  it("exposes the existing facade action keys", () => {
    const state = renderProbe();

    expect(Object.keys(state.actions).sort()).toEqual(
      [
        "handleAgentsChange",
        "handleAssignTask",
        "handleClearMessages",
        "handleCreateTask",
        "handleDeleteTask",
        "handleDismissAutoUpdateNotice",
        "handleOpenAnnouncement",
        "handleOpenChat",
        "handleOpenDecisionChat",
        "handleOpenDecisionInbox",
        "handlePauseTask",
        "handleRefreshCli",
        "handleReplyDecisionOption",
        "handleResumeTask",
        "handleRunSubtaskAction",
        "handleRunTask",
        "handleSaveSettings",
        "handleSendAnnouncement",
        "handleSendDirective",
        "handleSendMessage",
        "handleStopTask",
        "handleUpdateTask",
        "loadDecisionInbox",
      ].sort(),
    );
  });

  it("rolls settings back when saveSettings fails", async () => {
    vi.mocked(api.saveSettings).mockRejectedValue(new Error("save failed"));

    const state = renderProbe();
    const nextSettings = createSettings({ language: "ko", autoUpdateEnabled: true });

    await act(async () => {
      await state.actions.handleSaveSettings(nextSettings);
      await flushMicrotasks();
    });

    expect(latest?.settings.language).toBe("en");
    expect(latest?.settings.autoUpdateEnabled).toBe(false);
  });

  it("loads and exposes localized decision inbox items", async () => {
    vi.mocked(api.getMessages).mockResolvedValue([]);
    vi.mocked(api.getDecisionInbox).mockResolvedValue([
      {
        id: "workflow-1",
        kind: "project_review_ready",
        created_at: 100,
        summary: "Ready",
        project_id: "p1",
        project_name: "Project",
        project_path: "C:/project",
        task_id: "task-1",
        task_title: "Task 1",
        options: [{ number: 1, action: "start_project_review" }],
      },
    ]);

    const state = renderProbe();

    await act(async () => {
      state.actions.handleOpenDecisionInbox();
      await flushMicrotasks();
    });

    expect(latest?.showDecisionInbox).toBe(true);
    expect(latest?.decisionInboxLoading).toBe(false);
    expect(latest?.decisionInboxItems).toHaveLength(1);
    expect(latest?.decisionInboxItems[0]?.options[0]?.label).toBe("Start Team-Lead Meeting");
  });

  it("refreshes tasks and agents after assigning a task", async () => {
    vi.mocked(api.assignTask).mockResolvedValue(undefined);
    vi.mocked(api.getTasks).mockResolvedValue([createTask("task-1")]);
    vi.mocked(api.getAgents).mockResolvedValue([createAgent("agent-2")]);

    const state = renderProbe();

    await act(async () => {
      await state.actions.handleAssignTask("task-1", "agent-2");
      await flushMicrotasks();
    });

    expect(api.assignTask).toHaveBeenCalledWith("task-1", "agent-2");
    expect(api.getTasks).toHaveBeenCalledTimes(1);
    expect(api.getAgents).toHaveBeenCalledWith({ includeSeed: false });
    expect(latest?.tasks.map((task) => task.id)).toEqual(["task-1"]);
    expect(latest?.agents.map((agent) => agent.id)).toEqual(["agent-2"]);
  });

  it("replies to workflow decisions and schedules a live sync when resolved", async () => {
    vi.mocked(api.replyDecisionInbox).mockResolvedValue({
      ok: true,
      resolved: true,
      kind: "project_review_ready",
      action: "start_project_review",
    });
    vi.mocked(api.getMessages).mockResolvedValue([]);
    vi.mocked(api.getDecisionInbox).mockResolvedValue([]);

    const state = renderProbe();
    const item: DecisionInboxItem = {
      id: "workflow-1",
      kind: "project_review_ready",
      agentId: null,
      agentName: "Planning Lead",
      agentNameKo: "Planning Lead",
      requestContent: "Ready",
      options: [{ number: 1, label: "Start", action: "start_project_review" }],
      createdAt: 100,
      taskId: "task-1",
    };

    await act(async () => {
      await state.actions.handleReplyDecisionOption(item, 1);
      await flushMicrotasks();
    });

    expect(api.replyDecisionInbox).toHaveBeenCalledWith("workflow-1", 1, undefined);
    expect(latest?.scheduleLiveSync).toHaveBeenCalledWith(40);
    expect(api.getDecisionInbox).toHaveBeenCalled();
  });

  it("shows actionable guidance when project review start is blocked by unfinished subtasks", async () => {
    vi.mocked(api.replyDecisionInbox).mockResolvedValue({
      ok: true,
      resolved: false,
      kind: "project_review_ready",
      action: "start_project_review_blocked",
      blocked_tasks: [
        { id: "task-1", title: "사장의 생각", reason: "unfinished_subtasks", detail: "waiting for unfinished subtasks" },
      ],
    });
    vi.mocked(api.getMessages).mockResolvedValue([]);
    vi.mocked(api.getDecisionInbox).mockResolvedValue([]);

    const state = renderProbe();
    const item: DecisionInboxItem = {
      id: "workflow-2",
      kind: "project_review_ready",
      agentId: null,
      agentName: "Planning Lead",
      agentNameKo: "Planning Lead",
      requestContent: "Ready",
      options: [{ number: 1, label: "Start", action: "start_project_review" }],
      createdAt: 100,
      taskId: "task-1",
    };

    await act(async () => {
      await state.actions.handleReplyDecisionOption(item, 1);
      await flushMicrotasks();
    });

    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Expand the subtasks on the task board and finish the remaining items first"),
    );
  });
});
