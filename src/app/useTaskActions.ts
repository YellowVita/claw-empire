import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

import * as api from "../api";
import type { Agent, CompanySettings, CompanyStats, SubTask, Task, WorkflowPackKey } from "../types";
import { refreshTasksAndAgents } from "./useAppActionShared";

interface UseTaskActionsParams {
  settings: CompanySettings;
  scheduleLiveSync: (delayMs?: number) => void;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setStats: Dispatch<SetStateAction<CompanyStats | null>>;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  setSubtasks: Dispatch<SetStateAction<SubTask[]>>;
}

export function useTaskActions({
  settings,
  scheduleLiveSync,
  setTasks,
  setStats,
  setAgents,
  setSubtasks,
}: UseTaskActionsParams) {
  const refreshTaskAndAgentState = useCallback(
    async () =>
      refreshTasksAndAgents({
        settings,
        setTasks,
        setAgents,
      }),
    [settings, setTasks, setAgents],
  );

  const handleCreateTask = useCallback(
    async (input: {
      title: string;
      description?: string;
      department_id?: string;
      task_type?: string;
      priority?: number;
      project_id?: string;
      project_path?: string;
      assigned_agent_id?: string;
      workflow_pack_key?: WorkflowPackKey;
    }) => {
      try {
        await api.createTask(input as Parameters<typeof api.createTask>[0]);
        const tasks = await api.getTasks();
        setTasks(tasks);
        const stats = await api.getStats();
        setStats(stats);
      } catch (error) {
        console.error("Create task failed:", error);
      }
    },
    [setTasks, setStats],
  );

  const handleUpdateTask = useCallback(
    async (id: string, data: Partial<Task>) => {
      try {
        await api.updateTask(id, data);
        const tasks = await api.getTasks();
        setTasks(tasks);
      } catch (error) {
        console.error("Update task failed:", error);
      }
    },
    [setTasks],
  );

  const handleDeleteTask = useCallback(
    async (id: string) => {
      try {
        await api.deleteTask(id);
        setTasks((prev) => prev.filter((task) => task.id !== id));
      } catch (error) {
        console.error("Delete task failed:", error);
      }
    },
    [setTasks],
  );

  const handleAssignTask = useCallback(
    async (taskId: string, agentId: string) => {
      try {
        await api.assignTask(taskId, agentId);
        await refreshTaskAndAgentState();
      } catch (error) {
        console.error("Assign task failed:", error);
      }
    },
    [refreshTaskAndAgentState],
  );

  const handleRunTask = useCallback(
    async (id: string) => {
      try {
        await api.runTask(id);
        await refreshTaskAndAgentState();
      } catch (error) {
        console.error("Run task failed:", error);
      }
    },
    [refreshTaskAndAgentState],
  );

  const handleStopTask = useCallback(
    async (id: string) => {
      try {
        await api.stopTask(id);
        await refreshTaskAndAgentState();
      } catch (error) {
        console.error("Stop task failed:", error);
      }
    },
    [refreshTaskAndAgentState],
  );

  const handlePauseTask = useCallback(
    async (id: string) => {
      try {
        await api.pauseTask(id);
        await refreshTaskAndAgentState();
      } catch (error) {
        console.error("Pause task failed:", error);
      }
    },
    [refreshTaskAndAgentState],
  );

  const handleResumeTask = useCallback(
    async (id: string) => {
      try {
        await api.resumeTask(id);
        await refreshTaskAndAgentState();
      } catch (error) {
        console.error("Resume task failed:", error);
      }
    },
    [refreshTaskAndAgentState],
  );

  const handleRunSubtaskAction = useCallback(
    async (subtaskId: string, action: "retry" | "move_to_owner" | "mark_done") => {
      try {
        const updated = await api.runSubtaskAction(subtaskId, action);
        setSubtasks((prev) => prev.map((subtask) => (subtask.id === updated.id ? updated : subtask)));
        scheduleLiveSync(250);
      } catch (error) {
        console.error("Run subtask action failed:", error);
        throw error;
      }
    },
    [scheduleLiveSync, setSubtasks],
  );

  return {
    handleCreateTask,
    handleUpdateTask,
    handleDeleteTask,
    handleAssignTask,
    handleRunTask,
    handleStopTask,
    handlePauseTask,
    handleResumeTask,
    handleRunSubtaskAction,
  };
}
