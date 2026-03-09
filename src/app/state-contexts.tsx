import {
  type Context,
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import type { TaskReportDetail } from "../api";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import type {
  Agent,
  CeoOfficeCall,
  CliStatusMap,
  CompanyStats,
  CrossDeptDelivery,
  Department,
  MeetingPresence,
  Message,
  SubAgent,
  SubTask,
  Task,
} from "../types";
import type { TaskPanelTab } from "./types";

export interface AgentRuntimeContextValue {
  departments: Department[];
  setDepartments: Dispatch<SetStateAction<Department[]>>;
  agents: Agent[];
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  subAgents: SubAgent[];
  setSubAgents: Dispatch<SetStateAction<SubAgent[]>>;
  meetingPresence: MeetingPresence[];
  setMeetingPresence: Dispatch<SetStateAction<MeetingPresence[]>>;
  crossDeptDeliveries: CrossDeptDelivery[];
  setCrossDeptDeliveries: Dispatch<SetStateAction<CrossDeptDelivery[]>>;
  ceoOfficeCalls: CeoOfficeCall[];
  setCeoOfficeCalls: Dispatch<SetStateAction<CeoOfficeCall[]>>;
  streamingMessage: {
    message_id: string;
    agent_id: string;
    agent_name: string;
    agent_avatar: string;
    content: string;
  } | null;
  setStreamingMessage: Dispatch<
    SetStateAction<{
      message_id: string;
      agent_id: string;
      agent_name: string;
      agent_avatar: string;
      content: string;
    } | null>
  >;
}

export interface TaskRuntimeContextValue {
  tasks: Task[];
  setTasks: Dispatch<SetStateAction<Task[]>>;
  subtasks: SubTask[];
  setSubtasks: Dispatch<SetStateAction<SubTask[]>>;
  stats: CompanyStats | null;
  setStats: Dispatch<SetStateAction<CompanyStats | null>>;
  cliStatus: CliStatusMap | null;
  setCliStatus: Dispatch<SetStateAction<CliStatusMap | null>>;
}

export interface ChatRuntimeContextValue {
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  unreadAgentIds: Set<string>;
  setUnreadAgentIds: Dispatch<SetStateAction<Set<string>>>;
}

export interface ChatOverlayState {
  showChat: boolean;
  setShowChat: Dispatch<SetStateAction<boolean>>;
  chatAgent: Agent | null;
  setChatAgent: Dispatch<SetStateAction<Agent | null>>;
}

export interface SelectionOverlayState {
  selectedAgent: Agent | null;
  setSelectedAgent: Dispatch<SetStateAction<Agent | null>>;
  taskPanel: { taskId: string; tab: TaskPanelTab } | null;
  setTaskPanel: Dispatch<SetStateAction<{ taskId: string; tab: TaskPanelTab } | null>>;
}

export interface DecisionInboxState {
  showDecisionInbox: boolean;
  setShowDecisionInbox: Dispatch<SetStateAction<boolean>>;
  decisionInboxLoading: boolean;
  setDecisionInboxLoading: Dispatch<SetStateAction<boolean>>;
  decisionInboxItems: DecisionInboxItem[];
  setDecisionInboxItems: Dispatch<SetStateAction<DecisionInboxItem[]>>;
  decisionReplyBusyKey: string | null;
  setDecisionReplyBusyKey: Dispatch<SetStateAction<string | null>>;
}

export interface AuxiliaryOverlayState {
  taskReport: TaskReportDetail | null;
  setTaskReport: Dispatch<SetStateAction<TaskReportDetail | null>>;
  showReportHistory: boolean;
  setShowReportHistory: Dispatch<SetStateAction<boolean>>;
  showAgentStatus: boolean;
  setShowAgentStatus: Dispatch<SetStateAction<boolean>>;
  showRoomManager: boolean;
  setShowRoomManager: Dispatch<SetStateAction<boolean>>;
  activeRoomThemeTargetId: string | null;
  setActiveRoomThemeTargetId: Dispatch<SetStateAction<string | null>>;
}

const AgentRuntimeContext = createContext<AgentRuntimeContextValue | null>(null);
const TaskRuntimeContext = createContext<TaskRuntimeContextValue | null>(null);
const ChatRuntimeContext = createContext<ChatRuntimeContextValue | null>(null);
const ChatOverlayStateContext = createContext<ChatOverlayState | null>(null);
const SelectionOverlayStateContext = createContext<SelectionOverlayState | null>(null);
const DecisionInboxStateContext = createContext<DecisionInboxState | null>(null);
const AuxiliaryOverlayStateContext = createContext<AuxiliaryOverlayState | null>(null);

function useRequiredContext<T>(context: Context<T | null>, name: string): T {
  const value = useContext(context);
  if (!value) {
    throw new Error(`${name} must be used within AppStateProviders`);
  }
  return value;
}

export function AppStateProviders({ children }: { children: ReactNode }) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [subAgents, setSubAgents] = useState<SubAgent[]>([]);
  const [meetingPresence, setMeetingPresence] = useState<MeetingPresence[]>([]);
  const [crossDeptDeliveries, setCrossDeptDeliveries] = useState<CrossDeptDelivery[]>([]);
  const [ceoOfficeCalls, setCeoOfficeCalls] = useState<CeoOfficeCall[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentRuntimeContextValue["streamingMessage"]>(null);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [subtasks, setSubtasks] = useState<SubTask[]>([]);
  const [stats, setStats] = useState<CompanyStats | null>(null);
  const [cliStatus, setCliStatus] = useState<CliStatusMap | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [unreadAgentIds, setUnreadAgentIds] = useState<Set<string>>(new Set());

  const [showChat, setShowChat] = useState(false);
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [taskPanel, setTaskPanel] = useState<{ taskId: string; tab: TaskPanelTab } | null>(null);

  const [showDecisionInbox, setShowDecisionInbox] = useState(false);
  const [decisionInboxLoading, setDecisionInboxLoading] = useState(false);
  const [decisionInboxItems, setDecisionInboxItems] = useState<DecisionInboxItem[]>([]);
  const [decisionReplyBusyKey, setDecisionReplyBusyKey] = useState<string | null>(null);

  const [taskReport, setTaskReport] = useState<TaskReportDetail | null>(null);
  const [showReportHistory, setShowReportHistory] = useState(false);
  const [showAgentStatus, setShowAgentStatus] = useState(false);
  const [showRoomManager, setShowRoomManager] = useState(false);
  const [activeRoomThemeTargetId, setActiveRoomThemeTargetId] = useState<string | null>(null);

  const agentRuntimeValue = useMemo<AgentRuntimeContextValue>(
    () => ({
      departments,
      setDepartments,
      agents,
      setAgents,
      subAgents,
      setSubAgents,
      meetingPresence,
      setMeetingPresence,
      crossDeptDeliveries,
      setCrossDeptDeliveries,
      ceoOfficeCalls,
      setCeoOfficeCalls,
      streamingMessage,
      setStreamingMessage,
    }),
    [agents, ceoOfficeCalls, crossDeptDeliveries, departments, meetingPresence, streamingMessage, subAgents],
  );
  const taskRuntimeValue = useMemo<TaskRuntimeContextValue>(
    () => ({
      tasks,
      setTasks,
      subtasks,
      setSubtasks,
      stats,
      setStats,
      cliStatus,
      setCliStatus,
    }),
    [cliStatus, stats, subtasks, tasks],
  );
  const chatRuntimeValue = useMemo<ChatRuntimeContextValue>(
    () => ({
      messages,
      setMessages,
      unreadAgentIds,
      setUnreadAgentIds,
    }),
    [messages, unreadAgentIds],
  );
  const chatOverlayValue = useMemo<ChatOverlayState>(
    () => ({
      showChat,
      setShowChat,
      chatAgent,
      setChatAgent,
    }),
    [chatAgent, showChat],
  );
  const selectionOverlayValue = useMemo<SelectionOverlayState>(
    () => ({
      selectedAgent,
      setSelectedAgent,
      taskPanel,
      setTaskPanel,
    }),
    [selectedAgent, taskPanel],
  );
  const decisionInboxValue = useMemo<DecisionInboxState>(
    () => ({
      showDecisionInbox,
      setShowDecisionInbox,
      decisionInboxLoading,
      setDecisionInboxLoading,
      decisionInboxItems,
      setDecisionInboxItems,
      decisionReplyBusyKey,
      setDecisionReplyBusyKey,
    }),
    [decisionInboxItems, decisionInboxLoading, decisionReplyBusyKey, showDecisionInbox],
  );
  const auxiliaryOverlayValue = useMemo<AuxiliaryOverlayState>(
    () => ({
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
    }),
    [activeRoomThemeTargetId, showAgentStatus, showReportHistory, showRoomManager, taskReport],
  );

  return (
    <AgentRuntimeContext.Provider value={agentRuntimeValue}>
      <TaskRuntimeContext.Provider value={taskRuntimeValue}>
        <ChatRuntimeContext.Provider value={chatRuntimeValue}>
          <ChatOverlayStateContext.Provider value={chatOverlayValue}>
            <SelectionOverlayStateContext.Provider value={selectionOverlayValue}>
              <DecisionInboxStateContext.Provider value={decisionInboxValue}>
                <AuxiliaryOverlayStateContext.Provider value={auxiliaryOverlayValue}>
                  {children}
                </AuxiliaryOverlayStateContext.Provider>
              </DecisionInboxStateContext.Provider>
            </SelectionOverlayStateContext.Provider>
          </ChatOverlayStateContext.Provider>
        </ChatRuntimeContext.Provider>
      </TaskRuntimeContext.Provider>
    </AgentRuntimeContext.Provider>
  );
}

export function useAgentRuntime() {
  return useRequiredContext(AgentRuntimeContext, "useAgentRuntime");
}

export function useTaskRuntime() {
  return useRequiredContext(TaskRuntimeContext, "useTaskRuntime");
}

export function useChatRuntime() {
  return useRequiredContext(ChatRuntimeContext, "useChatRuntime");
}

export function useChatOverlayState() {
  return useRequiredContext(ChatOverlayStateContext, "useChatOverlayState");
}

export function useSelectionOverlayState() {
  return useRequiredContext(SelectionOverlayStateContext, "useSelectionOverlayState");
}

export function useDecisionInboxState() {
  return useRequiredContext(DecisionInboxStateContext, "useDecisionInboxState");
}

export function useAuxiliaryOverlayState() {
  return useRequiredContext(AuxiliaryOverlayStateContext, "useAuxiliaryOverlayState");
}
