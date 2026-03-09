import { useState, useRef, useMemo, useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "./api";
import { useTheme } from "./ThemeContext";
import AppLoadingScreen from "./app/AppLoadingScreen";
import AppMainLayout from "./app/AppMainLayout";
import AppOverlays from "./app/AppOverlays";
import { ROOM_THEMES_STORAGE_KEY, UPDATE_BANNER_DISMISS_STORAGE_KEY } from "./app/constants";
import {
  AppStateProviders,
  useAgentRuntime,
  useAuxiliaryOverlayState,
  useChatOverlayState,
  useChatRuntime,
  useDecisionInboxState,
  useSelectionOverlayState,
  useTaskRuntime,
} from "./app/state-contexts";
import { useActiveMeetingTaskId } from "./app/useActiveMeetingTaskId";
import { useAppActions } from "./app/useAppActions";
import { useAppBootstrapData } from "./app/useAppBootstrapData";
import { useAppLabels } from "./app/useAppLabels";
import { useAppLayoutSections } from "./app/useAppLayoutSections";
import { useAppViewEffects } from "./app/useAppViewEffects";
import { useLiveSyncScheduler } from "./app/useLiveSyncScheduler";
import { useRealtimeSync } from "./app/useRealtimeSync";
import { useUpdateStatusPolling } from "./app/useUpdateStatusPolling";
import { detectRuntimeOs, isForceUpdateBannerEnabled, mergeSettingsWithDefaults, readStoredRoomThemes } from "./app/utils";
import type { OAuthCallbackResult, RuntimeOs, RoomThemeMap, View } from "./app/types";
import {
  buildOfficePackPresentation,
  buildOfficePackStarterAgents,
  getOfficePackMeta,
  normalizeOfficeWorkflowPack,
  resolveOfficePackSeedProvider,
} from "./app/office-workflow-pack";
import { resolvePackAgentViews, resolvePackDepartmentsForDisplay } from "./app/office-pack-display";
import { detectBrowserLanguage, normalizeLanguage } from "./i18n";
import type {
  Agent,
  CompanySettings,
  Department,
  OfficePackProfile,
  RoomTheme,
  WorkflowPackKey,
} from "./types";
import { useWebSocket } from "./hooks/useWebSocket";

export type { OAuthCallbackResult } from "./app/types";

type AppShellProps = {
  theme: "light" | "dark";
  toggleTheme: () => void;
  initialRoomThemes: ReturnType<typeof readStoredRoomThemes>;
  hasLocalRoomThemesRef: MutableRefObject<boolean>;
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  settings: CompanySettings;
  setSettings: Dispatch<SetStateAction<CompanySettings>>;
  loading: boolean;
  setLoading: Dispatch<SetStateAction<boolean>>;
  oauthResult: OAuthCallbackResult | null;
  setOauthResult: Dispatch<SetStateAction<OAuthCallbackResult | null>>;
  customRoomThemes: RoomThemeMap;
  setCustomRoomThemes: Dispatch<SetStateAction<RoomThemeMap>>;
  mobileNavOpen: boolean;
  setMobileNavOpen: Dispatch<SetStateAction<boolean>>;
  mobileHeaderMenuOpen: boolean;
  setMobileHeaderMenuOpen: Dispatch<SetStateAction<boolean>>;
  officePackBootstrappingLabel: string | null;
  setOfficePackBootstrappingLabel: Dispatch<SetStateAction<string | null>>;
  runtimeOs: RuntimeOs;
  forceUpdateBanner: boolean;
  updateStatus: api.UpdateStatus | null;
  setUpdateStatus: Dispatch<SetStateAction<api.UpdateStatus | null>>;
  dismissedUpdateVersion: string;
  setDismissedUpdateVersion: Dispatch<SetStateAction<string>>;
};

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const initialRoomThemes = useMemo(() => readStoredRoomThemes(), []);
  const hasLocalRoomThemesRef = useRef<boolean>(initialRoomThemes.hasStored);

  const [view, setView] = useState<View>("office");
  const [settings, setSettings] = useState<CompanySettings>(() =>
    mergeSettingsWithDefaults({ language: detectBrowserLanguage() }),
  );
  const [loading, setLoading] = useState(true);
  const [oauthResult, setOauthResult] = useState<OAuthCallbackResult | null>(null);
  const [customRoomThemes, setCustomRoomThemes] = useState<RoomThemeMap>(() => initialRoomThemes.themes);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileHeaderMenuOpen, setMobileHeaderMenuOpen] = useState(false);
  const [officePackBootstrappingLabel, setOfficePackBootstrappingLabel] = useState<string | null>(null);
  const [runtimeOs] = useState<RuntimeOs>(() => detectRuntimeOs());
  const [forceUpdateBanner] = useState<boolean>(() => isForceUpdateBannerEnabled());
  const [updateStatus, setUpdateStatus] = useState<api.UpdateStatus | null>(null);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(UPDATE_BANNER_DISMISS_STORAGE_KEY) ?? "";
  });

  return (
    <AppStateProviders>
      <AppShell
        theme={theme}
        toggleTheme={toggleTheme}
        initialRoomThemes={initialRoomThemes}
        hasLocalRoomThemesRef={hasLocalRoomThemesRef}
        view={view}
        setView={setView}
        settings={settings}
        setSettings={setSettings}
        loading={loading}
        setLoading={setLoading}
        oauthResult={oauthResult}
        setOauthResult={setOauthResult}
        customRoomThemes={customRoomThemes}
        setCustomRoomThemes={setCustomRoomThemes}
        mobileNavOpen={mobileNavOpen}
        setMobileNavOpen={setMobileNavOpen}
        mobileHeaderMenuOpen={mobileHeaderMenuOpen}
        setMobileHeaderMenuOpen={setMobileHeaderMenuOpen}
        officePackBootstrappingLabel={officePackBootstrappingLabel}
        setOfficePackBootstrappingLabel={setOfficePackBootstrappingLabel}
        runtimeOs={runtimeOs}
        forceUpdateBanner={forceUpdateBanner}
        updateStatus={updateStatus}
        setUpdateStatus={setUpdateStatus}
        dismissedUpdateVersion={dismissedUpdateVersion}
        setDismissedUpdateVersion={setDismissedUpdateVersion}
      />
    </AppStateProviders>
  );
}

function AppShell({
  theme,
  toggleTheme,
  initialRoomThemes,
  hasLocalRoomThemesRef,
  view,
  setView,
  settings,
  setSettings,
  loading,
  setLoading,
  oauthResult,
  setOauthResult,
  customRoomThemes,
  setCustomRoomThemes,
  mobileNavOpen,
  setMobileNavOpen,
  mobileHeaderMenuOpen,
  setMobileHeaderMenuOpen,
  officePackBootstrappingLabel,
  setOfficePackBootstrappingLabel,
  runtimeOs,
  forceUpdateBanner,
  updateStatus,
  setUpdateStatus,
  dismissedUpdateVersion,
  setDismissedUpdateVersion,
}: AppShellProps) {
  const {
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
  } = useAgentRuntime();
  const { tasks, setTasks, subtasks, setSubtasks, stats, setStats, cliStatus, setCliStatus } = useTaskRuntime();
  const { messages, setMessages, unreadAgentIds, setUnreadAgentIds } = useChatRuntime();
  const { showChat, setShowChat, chatAgent, setChatAgent } = useChatOverlayState();
  const { selectedAgent, setSelectedAgent, taskPanel, setTaskPanel } = useSelectionOverlayState();
  const {
    showDecisionInbox,
    setShowDecisionInbox,
    decisionInboxLoading,
    setDecisionInboxLoading,
    decisionInboxItems,
    setDecisionInboxItems,
    setDecisionReplyBusyKey,
  } = useDecisionInboxState();
  const {
    setTaskReport,
    setShowReportHistory,
    setShowAgentStatus,
    setShowRoomManager,
    activeRoomThemeTargetId,
    setActiveRoomThemeTargetId,
  } = useAuxiliaryOverlayState();

  const viewRef = useRef<View>("office");
  viewRef.current = view;
  const agentsRef = useRef<Agent[]>(agents);
  agentsRef.current = agents;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const subAgentsRef = useRef(subAgents);
  subAgentsRef.current = subAgents;
  const codexThreadToSubAgentIdRef = useRef<Map<string, string>>(new Map());
  const codexThreadBindingTsRef = useRef<Map<string, number>>(new Map());
  const subAgentStreamTailRef = useRef<Map<string, string>>(new Map());
  const activeChatRef = useRef<{ showChat: boolean; agentId: string | null }>({ showChat: false, agentId: null });
  activeChatRef.current = { showChat, agentId: chatAgent?.id ?? null };
  const officePackBootstrapReqRef = useRef(0);

  const readHydratedPackSet = (source: CompanySettings): Set<string> => {
    const raw = source.officePackHydratedPacks;
    if (!Array.isArray(raw)) return new Set<string>();
    return new Set(raw.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0));
  };

  const getPackLabelByLanguage = (packKey: WorkflowPackKey, language: string): string => {
    const label = getOfficePackMeta(packKey).label;
    const lang = normalizeLanguage(language);
    if (lang === "ko") return label.ko || label.en;
    if (lang === "ja") return label.ja || label.en;
    if (lang === "zh") return label.zh || label.en;
    return label.en;
  };

  const maybeBuildSeedProfileForPack = (
    packKey: WorkflowPackKey,
    sourceSettings: CompanySettings,
  ): OfficePackProfile | null => {
    if (packKey === "development") return null;

    const existingProfile = sourceSettings.officePackProfiles?.[packKey];
    if (existingProfile?.departments?.length && existingProfile?.agents?.length) {
      return null;
    }

    const locale = normalizeLanguage(sourceSettings.language) as "ko" | "en" | "ja" | "zh";
    const presentation = buildOfficePackPresentation({
      packKey,
      locale,
      departments,
      agents,
      customRoomThemes,
    });
    if (presentation.departments.length <= 0) return null;

    const starterDrafts = buildOfficePackStarterAgents({
      packKey,
      departments: presentation.departments,
      targetCount: 8,
      locale,
    });
    if (starterDrafts.length <= 0) return null;

    const now = Date.now();
    const seededAgents: Agent[] = starterDrafts.map((draft, index) => ({
      id: `${packKey}-seed-${index + 1}`,
      name: draft.name,
      name_ko: draft.name_ko,
      name_ja: draft.name_ja,
      name_zh: draft.name_zh,
      department_id: draft.department_id,
      role: draft.role,
      acts_as_planning_leader: draft.acts_as_planning_leader,
      cli_provider: resolveOfficePackSeedProvider({
        packKey,
        departmentId: draft.department_id,
        role: draft.role,
        seedIndex: index + 1,
        seedOrderInDepartment: draft.seed_order_in_department,
      }),
      avatar_emoji: draft.avatar_emoji,
      sprite_number: draft.sprite_number,
      personality: draft.personality,
      status: "idle",
      current_task_id: null,
      stats_tasks_done: 0,
      stats_xp: 0,
      created_at: now + index,
    }));

    return {
      departments: presentation.departments,
      agents: seededAgents,
      updated_at: now,
    };
  };

  const handleOfficeWorkflowPackChange = (packKey: WorkflowPackKey) => {
    const previousPack = settings.officeWorkflowPack ?? "development";
    const previousProfiles = settings.officePackProfiles;
    const currentHydratedSet = readHydratedPackSet(settings);
    const shouldShowBootstrap = packKey !== "development" && !currentHydratedSet.has(packKey);
    const seedProfile = shouldShowBootstrap ? maybeBuildSeedProfileForPack(packKey, settings) : null;
    const nextOfficePackProfiles = seedProfile
      ? {
          ...(settings.officePackProfiles ?? {}),
          [packKey]: seedProfile,
        }
      : settings.officePackProfiles;
    const patchPayload: Record<string, unknown> = { officeWorkflowPack: packKey };
    if (seedProfile) {
      patchPayload.officePackProfiles = nextOfficePackProfiles;
    }
    const reqId = ++officePackBootstrapReqRef.current;
    if (shouldShowBootstrap) {
      setOfficePackBootstrappingLabel(getPackLabelByLanguage(packKey, settings.language));
    } else {
      setOfficePackBootstrappingLabel(null);
    }
    setSettings((prev) => ({
      ...prev,
      officeWorkflowPack: packKey,
      ...(seedProfile ? { officePackProfiles: nextOfficePackProfiles } : {}),
    }));
    api
      .saveSettingsPatch(patchPayload)
      .then(async () => {
        const [nextDepartments, nextAgents, nextSettingsRaw] = await Promise.all([
          api.getDepartments({ workflowPackKey: packKey }),
          api.getAgents({ includeSeed: packKey !== "development" }),
          api.getSettings(),
        ]);
        setDepartments(nextDepartments);
        setAgents(nextAgents);
        setSettings(mergeSettingsWithDefaults(nextSettingsRaw));
        const clearNotice = () => {
          if (officePackBootstrapReqRef.current !== reqId) return;
          setOfficePackBootstrappingLabel(null);
        };
        if (shouldShowBootstrap) {
          setTimeout(clearNotice, 650);
        } else {
          clearNotice();
        }
      })
      .catch((error) => {
        console.error("Save office workflow pack failed:", error);
        if (officePackBootstrapReqRef.current === reqId) {
          setOfficePackBootstrappingLabel(null);
        }
        setSettings((prev) =>
          prev.officeWorkflowPack === packKey
            ? {
                ...prev,
                officeWorkflowPack: previousPack,
                ...(seedProfile ? { officePackProfiles: previousProfiles } : {}),
              }
            : prev,
        );
      });
  };

  const { connected, on } = useWebSocket();
  const shouldIncludeSeedAgents = useCallback(
    () => normalizeOfficeWorkflowPack(settings.officeWorkflowPack ?? "development") !== "development",
    [settings.officeWorkflowPack],
  );
  const scheduleLiveSync = useLiveSyncScheduler({
    setTasks,
    setAgents,
    setStats,
    setDecisionInboxItems,
    shouldIncludeSeedAgents,
  });

  useAppBootstrapData({
    initialRoomThemes,
    hasLocalRoomThemesRef,
    setDepartments,
    setAgents,
    setTasks,
    setStats,
    setSettings,
    setSubtasks,
    setMeetingPresence,
    setDecisionInboxItems,
    setCustomRoomThemes,
    setLoading,
  });

  useUpdateStatusPolling(setUpdateStatus);
  useAppViewEffects({
    view,
    cliStatus,
    setView,
    setOauthResult,
    setCliStatus,
    setMobileNavOpen,
    setMeetingPresence,
  });

  useRealtimeSync({
    on,
    scheduleLiveSync,
    agentsRef,
    tasksRef,
    subAgentsRef,
    viewRef,
    activeChatRef,
    codexThreadToSubAgentIdRef,
    codexThreadBindingTsRef,
    subAgentStreamTailRef,
    setAgents,
    setMessages,
    setUnreadAgentIds,
    setTaskReport,
    setCrossDeptDeliveries,
    setCeoOfficeCalls,
    setMeetingPresence,
    setSubtasks,
    setSubAgents,
    setStreamingMessage,
  });

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

  const activeMeetingTaskId = useActiveMeetingTaskId(meetingPresence);
  const labels = useAppLabels({
    view,
    settings,
    departments,
    theme,
    runtimeOs,
    forceUpdateBanner,
    updateStatus,
    dismissedUpdateVersion,
  });

  const activePackKey = normalizeOfficeWorkflowPack(settings.officeWorkflowPack ?? "development");
  const activePackProfile =
    activePackKey === "development" ? null : (settings.officePackProfiles?.[activePackKey] ?? null);
  const overlayDepartments = useMemo(
    () =>
      resolvePackDepartmentsForDisplay({
        packKey: activePackKey,
        globalDepartments: departments,
        packDepartments: activePackProfile?.departments ?? null,
      }),
    [activePackKey, activePackProfile?.departments, departments],
  );
  const { mergedAgents: overlayAgents } = useMemo(
    () =>
      resolvePackAgentViews({
        packKey: activePackKey,
        globalAgents: agents,
        packAgents: activePackProfile?.agents ?? null,
      }),
    [activePackKey, activePackProfile?.agents, agents],
  );
  const handleSelectDepartment = useCallback(
    (department: Department) => {
      const leader =
        overlayAgents.find((agent) => agent.department_id === department.id && agent.role === "team_leader") ??
        (department.id === "planning"
          ? overlayAgents.find(
              (agent) => agent.role === "team_leader" && Number(agent.acts_as_planning_leader ?? 0) === 1,
            )
          : undefined);
      if (leader) actions.handleOpenChat(leader);
    },
    [actions, overlayAgents],
  );

  const layoutSections = useAppLayoutSections({
    shellProps: {
      mobileNavOpen,
      setMobileNavOpen,
      mobileHeaderMenuOpen,
      setMobileHeaderMenuOpen,
      theme,
      toggleTheme,
      decisionInboxLoading,
      decisionInboxCount: decisionInboxItems.length,
      onOpenDecisionInbox: actions.handleOpenDecisionInbox,
      onOpenAgentStatus: () => setShowAgentStatus(true),
      onOpenReportHistory: () => setShowReportHistory(true),
      onOpenAnnouncement: actions.handleOpenAnnouncement,
      onOpenRoomManager: () => setShowRoomManager(true),
      onDismissAutoUpdateNotice: actions.handleDismissAutoUpdateNotice,
      onDismissUpdate: () => {
        const latest = labels.effectiveUpdateStatus?.latest_version ?? "";
        setDismissedUpdateVersion(latest);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(UPDATE_BANNER_DISMISS_STORAGE_KEY, latest);
        }
      },
      officePackBootstrappingLabel,
    },
    officeProps: {
      departments,
      agents,
      meetingPresence,
      activeMeetingTaskId,
      unreadAgentIds,
      crossDeptDeliveries,
      ceoOfficeCalls,
      customRoomThemes,
      activeRoomThemeTargetId,
      onCrossDeptDeliveryProcessed: (id) =>
        setCrossDeptDeliveries((prev) => prev.filter((delivery) => delivery.id !== id)),
      onCeoOfficeCallProcessed: (id) => setCeoOfficeCalls((prev) => prev.filter((call) => call.id !== id)),
      onOpenActiveMeetingMinutes: (taskId) => setTaskPanel({ taskId, tab: "minutes" }),
      onSelectAgent: setSelectedAgent,
      onSelectDepartment: handleSelectDepartment,
      activeOfficeWorkflowPack: settings.officeWorkflowPack ?? "development",
      onChangeOfficeWorkflowPack: handleOfficeWorkflowPackChange,
      onAgentsChange: actions.handleAgentsChange,
    },
    taskBoardProps: {
      stats,
      tasks,
      subtasks,
      subAgents,
      onCreateTask: actions.handleCreateTask,
      onUpdateTask: actions.handleUpdateTask,
      onDeleteTask: actions.handleDeleteTask,
      onAssignTask: actions.handleAssignTask,
      onRunTask: actions.handleRunTask,
      onStopTask: actions.handleStopTask,
      onPauseTask: actions.handlePauseTask,
      onResumeTask: actions.handleResumeTask,
      onOpenTerminal: (taskId) => setTaskPanel({ taskId, tab: "terminal" }),
      onOpenMeetingMinutes: (taskId) => setTaskPanel({ taskId, tab: "minutes" }),
      onRunSubtaskAction: actions.handleRunSubtaskAction,
    },
    settingsProps: {
      settings,
      cliStatus,
      oauthResult,
      onSaveSettings: actions.handleSaveSettings,
      onRefreshCli: actions.handleRefreshCli,
      onOauthResultClear: () => setOauthResult(null),
    },
  });

  if (loading) {
    return (
      <AppLoadingScreen language={labels.uiLanguage} title={labels.loadingTitle} subtitle={labels.loadingSubtitle} />
    );
  }

  return (
    <AppMainLayout
      connected={connected}
      view={view}
      setView={setView}
      labels={labels}
      shellProps={layoutSections.shellProps}
      officeProps={layoutSections.officeProps}
      taskBoardProps={layoutSections.taskBoardProps}
      settingsProps={layoutSections.settingsProps}
    >
      <AppOverlays
        activeOfficeWorkflowPack={settings.officeWorkflowPack ?? "development"}
        uiLanguage={labels.uiLanguage}
        overlayAgents={overlayAgents}
        overlayDepartments={overlayDepartments}
        roomManagerDepartments={labels.roomManagerDepartments}
        customRoomThemes={customRoomThemes}
        onSendMessage={actions.handleSendMessage}
        onSendAnnouncement={actions.handleSendAnnouncement}
        onSendDirective={actions.handleSendDirective}
        onClearMessages={actions.handleClearMessages}
        onRefreshDecisionInbox={() => {
          void actions.loadDecisionInbox();
        }}
        onReplyDecisionOption={actions.handleReplyDecisionOption}
        onOpenAgentChat={actions.handleOpenChat}
        onOpenDecisionChat={actions.handleOpenDecisionChat}
        onAssignTaskFromAgentDetail={() => {
          setSelectedAgent(null);
          setView("tasks");
        }}
        onAgentUpdated={() => {
          api
            .getSettings()
            .then(async (nextSettingsRaw) => {
              const nextSettings = mergeSettingsWithDefaults(nextSettingsRaw);
              const activePack = nextSettings.officeWorkflowPack ?? "development";
              const nextAgents = await api.getAgents({ includeSeed: activePack !== "development" });
              setAgents(nextAgents);
              setSettings(nextSettings);

              if (!selectedAgent) return;
              const fromAgents = nextAgents.find((agent) => agent.id === selectedAgent.id);
              if (fromAgents) {
                setSelectedAgent(fromAgents);
                return;
              }

              const profilePackKey = nextSettings.officeWorkflowPack ?? "development";
              const fromPackProfile = nextSettings.officePackProfiles?.[profilePackKey]?.agents?.find(
                (agent) => agent.id === selectedAgent.id,
              );
              if (fromPackProfile) {
                setSelectedAgent(fromPackProfile);
              }
            })
            .catch(console.error);
        }}
        onRoomThemeChange={(themes) => {
          setCustomRoomThemes(themes as RoomThemeMap);
          hasLocalRoomThemesRef.current = true;
          try {
            window.localStorage.setItem(ROOM_THEMES_STORAGE_KEY, JSON.stringify(themes));
          } catch {
            // ignore quota errors
          }
          api.saveRoomThemes(themes as Record<string, RoomTheme>).catch((error) => {
            console.error("Save room themes failed:", error);
          });
        }}
      />
    </AppMainLayout>
  );
}
