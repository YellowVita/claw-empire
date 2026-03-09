import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

function createDeferredImport() {
  let resolve: ((value: { default: () => JSX.Element }) => void) | null = null;
  const promise = new Promise<{ default: () => JSX.Element }>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value: { default: () => JSX.Element }) {
      resolve?.(value);
    },
  };
}

async function loadAppMainLayoutWithDeferredOfficeView() {
  vi.resetModules();
  const deferredImport = createDeferredImport();
  vi.doMock("./loadOfficeView", () => ({
    loadOfficeView: () => deferredImport.promise,
  }));
  return {
    deferredImport,
    AppMainLayout: (await import("./AppMainLayout")).default,
  };
}

function createBaseProps() {
  return {
    connected: true,
    view: "office",
    setView: vi.fn(),
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
    shellProps: {
      mobileNavOpen: false,
      setMobileNavOpen: vi.fn(),
      mobileHeaderMenuOpen: false,
      setMobileHeaderMenuOpen: vi.fn(),
      theme: "dark",
      toggleTheme: vi.fn(),
      decisionInboxLoading: false,
      decisionInboxCount: 0,
      onOpenDecisionInbox: vi.fn(),
      onOpenAgentStatus: vi.fn(),
      onOpenReportHistory: vi.fn(),
      onOpenAnnouncement: vi.fn(),
      onOpenRoomManager: vi.fn(),
      onDismissAutoUpdateNotice: vi.fn(async () => {}),
      onDismissUpdate: vi.fn(),
      officePackBootstrappingLabel: null,
    },
    officeProps: {
      departments: [],
      agents: [],
      meetingPresence: [],
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
      activeOfficeWorkflowPack: "development",
      onChangeOfficeWorkflowPack: vi.fn(),
      onAgentsChange: vi.fn(),
    },
    taskBoardProps: {
      stats: null,
      tasks: [],
      subtasks: [],
      subAgents: [],
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
    },
    settingsProps: {
      settings: {
        companyName: "Claw-Empire",
        officeWorkflowPack: "development",
        officePackProfiles: {},
        officePackHydratedPacks: [],
      },
      cliStatus: null,
      oauthResult: null,
      onSaveSettings: vi.fn(async () => {}),
      onRefreshCli: vi.fn(async () => {}),
      onOauthResultClear: vi.fn(),
    },
  } as any;
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.doUnmock("./loadOfficeView");
});

describe("AppMainLayout office lazy loading", () => {
  it("office view chunk가 아직 로드되지 않았으면 fallback을 먼저 보여주고 resolve 후 경고 없이 로드한다", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deferredImport, AppMainLayout } = await loadAppMainLayoutWithDeferredOfficeView();
    const props = createBaseProps();

    const view = render(<AppMainLayout {...props} />);

    expect(screen.getByText("Loading office view...")).toBeInTheDocument();

    await act(async () => {
      deferredImport.resolve({
        default() {
          return <div>Office loaded</div>;
        },
      });
      await deferredImport.promise;
      view.rerender(<AppMainLayout {...props} />);
      await Promise.resolve();
    });

    expect(await screen.findByText("Office loaded")).toBeInTheDocument();
    expect(
      consoleErrorSpy.mock.calls.some((call) =>
        call.some((value) => String(value).includes("A suspended resource finished loading inside a test")),
      ),
    ).toBe(false);
    consoleErrorSpy.mockRestore();
  }, 15000);
});
