import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { registerRoutesPartB } from "./collab.ts";

describe("registerRoutesPartB subtask delegation wiring", () => {
  it("builds subtask delegation tools even when runtime findTeamLeader is unresolved", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);

      const runtime = {
        db,
        activeProcesses: new Map(),
        broadcast: vi.fn(),
        buildCliFailureMessage: vi.fn(),
        buildDirectReplyPrompt: vi.fn(),
        executeApiProviderAgent: vi.fn(),
        executeCopilotAgent: vi.fn(),
        executeAntigravityAgent: vi.fn(),
        buildTaskExecutionPrompt: vi.fn((parts: string[]) => parts.join("\n")),
        chooseSafeReply: vi.fn(),
        createWorktree: vi.fn(),
        delegatedTaskToSubtask: new Map(),
        appendTaskLog: vi.fn(),
        ensureClaudeMd: vi.fn(),
        ensureTaskExecutionSession: vi.fn(() => ({ sessionId: "s1", agentId: "a1", provider: "codex" })),
        finishReview: vi.fn(),
        findTeamLeader: undefined,
        getAgentDisplayName: vi.fn((agent: { name?: string }) => agent.name ?? "agent"),
        getProviderModelConfig: vi.fn(() => ({})),
        getRecentConversationContext: vi.fn(() => ""),
        handleTaskRunComplete: vi.fn(),
        hasExplicitWarningFixRequest: vi.fn(() => false),
        getNextHttpAgentPid: vi.fn(() => 1),
        isTaskWorkflowInterrupted: vi.fn(() => false),
        launchApiProviderAgent: vi.fn(),
        launchHttpAgent: vi.fn(),
        logsDir: "C:/logs",
        notifyCeo: vi.fn(),
        nowMs: vi.fn(() => 1_000),
        randomDelay: vi.fn(),
        recordTaskCreationAudit: vi.fn(),
        runAgentOneShot: vi.fn(),
        seedApprovedPlanSubtasks: vi.fn(),
        spawnCliAgent: vi.fn(),
        startPlannedApprovalMeeting: vi.fn(),
        startProgressTimer: vi.fn(),
        startTaskExecutionForAgent: vi.fn(),
        stopRequestModeByTask: new Map(),
        stopRequestedTasks: new Set(),
        subtaskDelegationCallbacks: new Map(),
        subtaskDelegationCompletionNoticeSent: new Set(),
        subtaskDelegationDispatchInFlight: new Set(),
        resolveProjectPath: vi.fn(() => "C:/workspace/project"),
        crossDeptNextCallbacks: new Map(),
        buildAvailableSkillsPromptBlock: vi.fn(() => ""),
      } as any;

      const exports = registerRoutesPartB(runtime);

      expect(typeof exports.findTeamLeader).toBe("function");
      expect(typeof exports.processSubtaskDelegations).toBe("function");
    } finally {
      db.close();
    }
  });
});
