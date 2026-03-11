import type { Agent, Department, RoomTheme, WorkflowPackKey } from "../types";
import type { TaskReportDetail } from "../api";
import { ChatPanel } from "../components/ChatPanel";
import DecisionInboxModal from "../components/DecisionInboxModal";
import AgentDetail from "../components/AgentDetail";
import TerminalPanel from "../components/TerminalPanel";
import TaskReportPopup from "../components/TaskReportPopup";
import ReportHistory from "../components/ReportHistory";
import AgentStatusPanel from "../components/AgentStatusPanel";
import OfficeRoomManager from "../components/OfficeRoomManager";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import type { UiLanguage } from "../i18n";
import type { ProjectMetaPayload, RoomThemeMap } from "./types";
import {
  useAgentRuntime,
  useAuxiliaryOverlayState,
  useChatOverlayState,
  useChatRuntime,
  useDecisionInboxState,
  useSelectionOverlayState,
  useTaskRuntime,
} from "./state-contexts";

interface AppOverlaysProps {
  activeOfficeWorkflowPack: WorkflowPackKey;
  uiLanguage: UiLanguage;
  overlayAgents: Agent[];
  overlayDepartments: Department[];
  roomManagerDepartments: { id: string; name: string }[];
  customRoomThemes: RoomThemeMap;
  onSendMessage: (
    content: string,
    receiverType: "agent" | "department" | "all",
    receiverId?: string,
    messageType?: string,
    projectMeta?: ProjectMetaPayload,
  ) => Promise<void>;
  onSendAnnouncement: (content: string) => Promise<void>;
  onSendDirective: (content: string, projectMeta?: ProjectMetaPayload) => Promise<void>;
  onClearMessages: (agentId?: string) => Promise<void>;
  onRefreshDecisionInbox: () => void;
  onReplyDecisionOption: (
    item: DecisionInboxItem,
    optionNumber: number,
    payloadInput?: { note?: string; selected_option_numbers?: number[] },
  ) => Promise<void>;
  onOpenAgentChat: (agent: Agent) => void;
  onOpenDecisionChat: (agentId: string) => void;
  onAssignTaskFromAgentDetail: () => void;
  onAgentUpdated: () => void;
  onRoomThemeChange: (themes: Record<string, RoomTheme>) => void;
}

export default function AppOverlays({
  activeOfficeWorkflowPack,
  uiLanguage,
  overlayAgents,
  overlayDepartments,
  roomManagerDepartments,
  customRoomThemes,
  onSendMessage,
  onSendAnnouncement,
  onSendDirective,
  onClearMessages,
  onRefreshDecisionInbox,
  onReplyDecisionOption,
  onOpenAgentChat,
  onOpenDecisionChat,
  onAssignTaskFromAgentDetail,
  onAgentUpdated,
  onRoomThemeChange,
}: AppOverlaysProps) {
  const { subAgents, streamingMessage } = useAgentRuntime();
  const { messages } = useChatRuntime();
  const { tasks, subtasks } = useTaskRuntime();
  const { showChat, setShowChat, chatAgent } = useChatOverlayState();
  const { selectedAgent, setSelectedAgent, taskPanel, setTaskPanel } = useSelectionOverlayState();
  const {
    showDecisionInbox,
    setShowDecisionInbox,
    decisionInboxLoading,
    decisionInboxItems,
    decisionReplyBusyKey,
  } = useDecisionInboxState();
  const {
    taskReport,
    setTaskReport,
    showReportHistory,
    setShowReportHistory,
    showAgentStatus,
    setShowAgentStatus,
    showRoomManager,
    setShowRoomManager,
    activeRoomThemeTargetId,
    setActiveRoomThemeTargetId,
  } = useAuxiliaryOverlayState();

  return (
    <>
      {showChat && (
        <ChatPanel
          selectedAgent={chatAgent}
          messages={messages}
          agents={overlayAgents}
          streamingMessage={streamingMessage}
          onSendMessage={onSendMessage}
          onSendAnnouncement={onSendAnnouncement}
          onSendDirective={onSendDirective}
          onClearMessages={onClearMessages}
          onClose={() => setShowChat(false)}
        />
      )}

      {showDecisionInbox && (
        <DecisionInboxModal
          open={showDecisionInbox}
          loading={decisionInboxLoading}
          items={decisionInboxItems}
          agents={overlayAgents}
          busyKey={decisionReplyBusyKey}
          uiLanguage={uiLanguage}
          onClose={() => setShowDecisionInbox(false)}
          onRefresh={onRefreshDecisionInbox}
          onReplyOption={onReplyDecisionOption}
          onOpenChat={onOpenDecisionChat}
        />
      )}

      {selectedAgent && (
        <AgentDetail
          agent={selectedAgent}
          agents={overlayAgents}
          department={overlayDepartments.find((d) => d.id === selectedAgent.department_id)}
          departments={overlayDepartments}
          tasks={tasks}
          subAgents={subAgents}
          subtasks={subtasks}
          onClose={() => setSelectedAgent(null)}
          onChat={(agent) => {
            setSelectedAgent(null);
            onOpenAgentChat(agent);
          }}
          onAssignTask={onAssignTaskFromAgentDetail}
          onOpenTerminal={(taskId) => {
            setSelectedAgent(null);
            setTaskPanel({ taskId, tab: "terminal" });
          }}
          onAgentUpdated={onAgentUpdated}
          activeOfficeWorkflowPack={activeOfficeWorkflowPack}
        />
      )}

      {taskPanel && (
        <TerminalPanel
          taskId={taskPanel.taskId}
          initialTab={taskPanel.tab}
          task={tasks.find((t) => t.id === taskPanel.taskId)}
          agent={overlayAgents.find(
            (a) =>
              a.current_task_id === taskPanel.taskId ||
              tasks.find((t) => t.id === taskPanel.taskId)?.assigned_agent_id === a.id,
          )}
          agents={overlayAgents}
          onClose={() => setTaskPanel(null)}
        />
      )}

      {taskReport && (
        <TaskReportPopup
          report={taskReport as TaskReportDetail}
          agents={overlayAgents}
          departments={overlayDepartments}
          uiLanguage={uiLanguage}
          onClose={() => setTaskReport(null)}
        />
      )}

      {showReportHistory && (
        <ReportHistory
          agents={overlayAgents}
          departments={overlayDepartments}
          uiLanguage={uiLanguage}
          onClose={() => setShowReportHistory(false)}
        />
      )}

      {showAgentStatus && (
        <AgentStatusPanel agents={overlayAgents} uiLanguage={uiLanguage} onClose={() => setShowAgentStatus(false)} />
      )}

      {showRoomManager && (
        <OfficeRoomManager
          departments={roomManagerDepartments}
          customThemes={customRoomThemes}
          onActiveDeptChange={setActiveRoomThemeTargetId}
          onThemeChange={onRoomThemeChange}
          onClose={() => {
            setShowRoomManager(false);
            setActiveRoomThemeTargetId(null);
          }}
          language={uiLanguage}
        />
      )}
    </>
  );
}
