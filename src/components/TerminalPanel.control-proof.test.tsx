import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { I18nProvider } from "../i18n";
import TerminalPanel from "./TerminalPanel";

vi.mock("../api", () => ({
  getTerminal: vi.fn(async () => ({
    ok: true,
    exists: true,
    path: "/tmp/task-1.log",
    text: "terminal output",
    task_logs: [],
    progress_hints: null,
  })),
  getTaskMeetingMinutes: vi.fn(async () => []),
  getTaskInterruptProof: vi.fn(async () => ({
    session_id: "session-proof-1",
    control_token: "token-proof-1",
    requires_csrf: true,
  })),
  pauseTaskWithProof: vi.fn(async () => ({
    ok: true,
    stopped: true,
    status: "pending",
  })),
  injectTaskPrompt: vi.fn(async () => ({
    ok: true,
    queued: true,
    session_id: "session-proof-1",
    prompt_hash: "hash",
    pending_count: 1,
  })),
  resumeTaskWithProof: vi.fn(async () => ({
    ok: true,
    status: "planned",
    auto_resumed: true,
  })),
  isApiRequestError: vi.fn(() => false),
}));

describe("TerminalPanel control proof flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch proof from polling and requests it explicitly before inject+resume", async () => {
    const user = userEvent.setup();

    render(
      <I18nProvider language="en">
        <TerminalPanel
          taskId="task-1"
          task={
            {
              id: "task-1",
              title: "Pending task",
              status: "pending",
              assigned_agent_id: "agent-1",
            } as any
          }
          agent={{ id: "agent-1", name: "Ari", name_ko: "아리", avatar_emoji: "A" } as any}
          agents={[] as any}
          initialTab="terminal"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(api.getTerminal).toHaveBeenCalled();
    });
    expect(api.getTaskInterruptProof).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Inject" }));
    await user.type(screen.getByRole("textbox"), "Run tests before resuming.");
    await user.click(screen.getByRole("button", { name: "Inject + Resume" }));

    await waitFor(() => {
      expect(api.getTaskInterruptProof).toHaveBeenCalledWith("task-1");
      expect(api.injectTaskPrompt).toHaveBeenCalledWith("task-1", {
        session_id: "session-proof-1",
        interrupt_token: "token-proof-1",
        prompt: "Run tests before resuming.",
      });
      expect(api.resumeTaskWithProof).toHaveBeenCalledWith("task-1", {
        session_id: "session-proof-1",
        control_token: "token-proof-1",
        requires_csrf: true,
      });
    });
    expect(api.pauseTaskWithProof).not.toHaveBeenCalled();
  });
});
