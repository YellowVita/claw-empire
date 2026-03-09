import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

async function loadAppMainLayoutWithPendingOfficeView() {
  vi.resetModules();
  const pendingOfficeView = new Promise<never>(() => {});
  vi.doMock("../components/OfficeView", () => ({
    __esModule: true,
    default() {
      throw pendingOfficeView;
    },
  }));
  return (await import("./AppMainLayout")).default;
}

function createBaseProps() {
  return {
    connected: true,
    view: "office",
    setView: vi.fn(),
    departments: [],
    agents: [],
    stats: null,
    tasks: [],
    subtasks: [],
    subAgents: [],
    meetingPresence: [],
    settings: {
      companyName: "Claw-Empire",
      officeWorkflowPack: "development",
      officePackProfiles: {},
      officePackHydratedPacks: [],
    },
    cliStatus: null,
    oauthResult: null,
    labels: {
      uiLanguage: "en",
      viewTitle: "Office",
      announcementLabel: "Announcement",
      roomManagerLabel: "Room Manager",
      roomManagerDepartments: [],
      reportLabel: "Reports",
      tasksPrimaryLabel: "Tasks",
      agentStatusLabel: "Agent Status",
      decisionLabel: "Decisions",
      autoUpdateNoticeVisible: false,
      autoUpdateNoticeTitle: "",
      autoUpdateNoticeHint: "",
      autoUpdateNoticeActionLabel: "",
      autoUpdateNoticeContainerClass: "",
      autoUpdateNoticeTextClass: "",
      autoUpdateNoticeHintClass: "",
      autoUpdateNoticeButtonClass: "",
      effectiveUpdateStatus: null,
      updateBannerVisible: false,
      updateReleaseUrl: "",
      updateTitle: "",
      updateHint: "",
      updateReleaseLabel: "",
      updateDismissLabel: "",
      updateTestModeHint: "",
    },
    mobileNavOpen: false,
    setMobileNavOpen: vi.fn(),
    mobileHeaderMenuOpen: false,
    setMobileHeaderMenuOpen: vi.fn(),
    theme: "dark",
    toggleTheme: vi.fn(),
    decisionInboxLoading: false,
    decisionInboxCount: 0,
    activeMeetingTaskId: null,
    unreadAgentIds: new Set<string>(),
    crossDeptDeliveries: [],
    ceoOfficeCalls: [],
    customRoomThemes: {},
    activeRoomThemeTargetId: null,
    onCrossDeptDeliveryProcessed: vi.fn(),
    onCeoOfficeCallProcessed: vi.fn(),
    onOpenActiveMeetingMinutes: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectDepartment: vi.fn(),
    onCreateTask: vi.fn(async () => {}),
    onUpdateTask: vi.fn(async () => {}),
    onDeleteTask: vi.fn(async () => {}),
    onAssignTask: vi.fn(async () => {}),
    onRunTask: vi.fn(async () => {}),
    onStopTask: vi.fn(async () => {}),
    onPauseTask: vi.fn(async () => {}),
    onResumeTask: vi.fn(async () => {}),
    onOpenTerminal: vi.fn(),
    onOpenMeetingMinutes: vi.fn(),
    onRunSubtaskAction: vi.fn(async () => {}),
    onAgentsChange: vi.fn(),
    activeOfficeWorkflowPack: "development",
    onChangeOfficeWorkflowPack: vi.fn(),
    onSaveSettings: vi.fn(async () => {}),
    onRefreshCli: vi.fn(async () => {}),
    onOauthResultClear: vi.fn(),
    onOpenDecisionInbox: vi.fn(),
    onOpenAgentStatus: vi.fn(),
    onOpenReportHistory: vi.fn(),
    onOpenAnnouncement: vi.fn(),
    onOpenRoomManager: vi.fn(),
    onDismissAutoUpdateNotice: vi.fn(async () => {}),
    onDismissUpdate: vi.fn(),
    officePackBootstrappingLabel: null,
  } as any;
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.doUnmock("../components/OfficeView");
});

describe("AppMainLayout office lazy loading", () => {
  it("office view chunk가 아직 로드되지 않았으면 fallback을 먼저 보여준다", async () => {
    const AppMainLayout = await loadAppMainLayoutWithPendingOfficeView();

    render(<AppMainLayout {...createBaseProps()} />);

    expect(screen.getByText("Loading office view...")).toBeInTheDocument();
  });
});
