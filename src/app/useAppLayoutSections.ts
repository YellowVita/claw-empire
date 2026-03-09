import { useMemo } from "react";
import type {
  Agent,
  CeoOfficeCall,
  CliStatusMap,
  CompanyStats,
  CompanySettings,
  CrossDeptDelivery,
  Department,
  MeetingPresence,
  SubAgent,
  SubTask,
  Task,
  WorkflowPackKey,
} from "../types";
import type { OAuthCallbackResult, RoomThemeMap } from "./types";

export interface AppShellSectionProps {
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
  mobileHeaderMenuOpen: boolean;
  setMobileHeaderMenuOpen: (open: boolean) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  decisionInboxLoading: boolean;
  decisionInboxCount: number;
  onOpenDecisionInbox: () => void;
  onOpenAgentStatus: () => void;
  onOpenReportHistory: () => void;
  onOpenAnnouncement: () => void;
  onOpenRoomManager: () => void;
  onDismissAutoUpdateNotice: () => Promise<void>;
  onDismissUpdate: () => void;
  officePackBootstrappingLabel?: string | null;
}

export interface AppOfficeSectionProps {
  departments: Department[];
  agents: Agent[];
  meetingPresence: MeetingPresence[];
  activeMeetingTaskId: string | null;
  unreadAgentIds: Set<string>;
  crossDeptDeliveries: CrossDeptDelivery[];
  ceoOfficeCalls: CeoOfficeCall[];
  customRoomThemes: RoomThemeMap;
  activeRoomThemeTargetId: string | null;
  onCrossDeptDeliveryProcessed: (id: string) => void;
  onCeoOfficeCallProcessed: (id: string) => void;
  onOpenActiveMeetingMinutes: (taskId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onSelectDepartment: (department: Department) => void;
  activeOfficeWorkflowPack: WorkflowPackKey;
  onChangeOfficeWorkflowPack: (packKey: WorkflowPackKey) => void;
  onAgentsChange: () => void;
}

export interface AppTaskBoardSectionProps {
  stats: CompanyStats | null;
  tasks: Task[];
  subtasks: SubTask[];
  subAgents: SubAgent[];
  onCreateTask: (input: {
    title: string;
    description?: string;
    department_id?: string;
    task_type?: string;
    priority?: number;
    project_id?: string;
    project_path?: string;
    assigned_agent_id?: string;
    workflow_pack_key?: WorkflowPackKey;
  }) => Promise<void>;
  onUpdateTask: (id: string, data: Partial<Task>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onAssignTask: (taskId: string, agentId: string) => Promise<void>;
  onRunTask: (id: string) => Promise<void>;
  onStopTask: (id: string) => Promise<void>;
  onPauseTask: (id: string) => Promise<void>;
  onResumeTask: (id: string) => Promise<void>;
  onOpenTerminal: (taskId: string) => void;
  onOpenMeetingMinutes: (taskId: string) => void;
  onRunSubtaskAction: (subtaskId: string, action: "retry" | "move_to_owner" | "mark_done") => Promise<void>;
}

export interface AppSettingsSectionProps {
  settings: CompanySettings;
  cliStatus: CliStatusMap | null;
  oauthResult: OAuthCallbackResult | null;
  onSaveSettings: (settings: CompanySettings) => Promise<void>;
  onRefreshCli: () => Promise<void>;
  onOauthResultClear: () => void;
}

interface UseAppLayoutSectionsParams {
  shellProps: AppShellSectionProps;
  officeProps: AppOfficeSectionProps;
  taskBoardProps: AppTaskBoardSectionProps;
  settingsProps: AppSettingsSectionProps;
}

export function useAppLayoutSections(params: UseAppLayoutSectionsParams) {
  const shellProps = useMemo(() => params.shellProps, [params.shellProps]);
  const officeProps = useMemo(() => params.officeProps, [params.officeProps]);
  const taskBoardProps = useMemo(() => params.taskBoardProps, [params.taskBoardProps]);
  const settingsProps = useMemo(() => params.settingsProps, [params.settingsProps]);

  return {
    shellProps,
    officeProps,
    taskBoardProps,
    settingsProps,
  };
}
