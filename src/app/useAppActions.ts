import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import { normalizeLanguage, pickLang } from "../i18n";
import type {
  Agent,
  CliStatusMap,
  CompanySettings,
  CompanyStats,
  Department,
  Message,
  SubTask,
  Task,
} from "../types";
import { useChatActions } from "./useChatActions";
import { useDecisionActions } from "./useDecisionActions";
import { useSettingsActions } from "./useSettingsActions";
import { useTaskActions } from "./useTaskActions";

interface UseAppActionsParams {
  agents: Agent[];
  settings: CompanySettings;
  scheduleLiveSync: (delayMs?: number) => void;
  setSettings: Dispatch<SetStateAction<CompanySettings>>;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  setDepartments: Dispatch<SetStateAction<Department[]>>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setSubtasks: Dispatch<SetStateAction<SubTask[]>>;
  setStats: Dispatch<SetStateAction<CompanyStats | null>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setChatAgent: Dispatch<SetStateAction<Agent | null>>;
  setShowChat: Dispatch<SetStateAction<boolean>>;
  setUnreadAgentIds: Dispatch<SetStateAction<Set<string>>>;
  setShowDecisionInbox: Dispatch<SetStateAction<boolean>>;
  setDecisionInboxLoading: Dispatch<SetStateAction<boolean>>;
  setDecisionInboxItems: Dispatch<SetStateAction<DecisionInboxItem[]>>;
  setDecisionReplyBusyKey: Dispatch<SetStateAction<string | null>>;
  setCliStatus: Dispatch<SetStateAction<CliStatusMap | null>>;
}

export function useAppActions({
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
}: UseAppActionsParams) {
  const taskActions = useTaskActions({
    settings,
    scheduleLiveSync,
    setTasks,
    setStats,
    setAgents,
    setSubtasks,
  });
  const chatActions = useChatActions({
    setMessages,
    setChatAgent,
    setShowChat,
    setUnreadAgentIds,
  });
  const decisionActions = useDecisionActions({
    agents,
    language: settings.language,
    scheduleLiveSync,
    setShowDecisionInbox,
    setDecisionInboxLoading,
    setDecisionInboxItems,
    setDecisionReplyBusyKey,
  });
  const settingsActions = useSettingsActions({
    settings,
    setSettings,
    setCliStatus,
    setAgents,
    setDepartments,
    setTasks,
  });

  const handleOpenDecisionChat = useCallback(
    (agentId: string) => {
      const matchedAgent = agents.find((agent) => agent.id === agentId);
      if (!matchedAgent) {
        window.alert(
          pickLang(normalizeLanguage(settings.language), {
            ko: "요청 에이전트 정보를 찾지 못했습니다.",
            en: "Could not find the requested agent.",
            ja: "対象エージェント情報が見つかりません。",
            zh: "未找到对应代理信息。",
          }),
        );
        return;
      }
      setShowDecisionInbox(false);
      chatActions.handleOpenChat(matchedAgent);
    },
    [agents, chatActions, settings.language, setShowDecisionInbox],
  );

  return {
    handleSendMessage: chatActions.handleSendMessage,
    handleSendAnnouncement: chatActions.handleSendAnnouncement,
    handleSendDirective: chatActions.handleSendDirective,
    handleCreateTask: taskActions.handleCreateTask,
    handleUpdateTask: taskActions.handleUpdateTask,
    handleDeleteTask: taskActions.handleDeleteTask,
    handleAssignTask: taskActions.handleAssignTask,
    handleRunTask: taskActions.handleRunTask,
    handleStopTask: taskActions.handleStopTask,
    handlePauseTask: taskActions.handlePauseTask,
    handleResumeTask: taskActions.handleResumeTask,
    handleRunSubtaskAction: taskActions.handleRunSubtaskAction,
    handleSaveSettings: settingsActions.handleSaveSettings,
    handleDismissAutoUpdateNotice: settingsActions.handleDismissAutoUpdateNotice,
    handleOpenChat: chatActions.handleOpenChat,
    loadDecisionInbox: decisionActions.loadDecisionInbox,
    handleOpenDecisionInbox: decisionActions.handleOpenDecisionInbox,
    handleOpenDecisionChat,
    handleReplyDecisionOption: decisionActions.handleReplyDecisionOption,
    handleAgentsChange: settingsActions.handleAgentsChange,
    handleRefreshCli: settingsActions.handleRefreshCli,
    handleOpenAnnouncement: chatActions.handleOpenAnnouncement,
    handleClearMessages: chatActions.handleClearMessages,
  };
}
