import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import type { Agent } from "../types";
import { ChatPanel } from "./ChatPanel";

function buildAgent(): Agent {
  return {
    id: "planning-lead",
    name: "Planning Lead",
    name_ko: "기획 팀장",
    department_id: "planning",
    department: {
      id: "planning",
      name: "Planning",
      name_ko: "기획",
      icon: "📋",
      color: "#fff",
      description: null,
      prompt: null,
      sort_order: 1,
      created_at: 1,
    },
    role: "team_leader",
    cli_provider: "codex",
    avatar_emoji: "🧭",
    personality: null,
    status: "idle",
    current_task_id: null,
    stats_tasks_done: 0,
    stats_xp: 0,
    created_at: 1,
  };
}

describe("ChatPanel default mode", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("opens agent chat in chat mode instead of task mode", () => {
    render(
      <I18nProvider language="en">
        <ChatPanel
          selectedAgent={buildAgent()}
          messages={[]}
          agents={[buildAgent()]}
          streamingMessage={null}
          onSendMessage={vi.fn()}
          onSendAnnouncement={vi.fn()}
          onSendDirective={vi.fn()}
          onClearMessages={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByPlaceholderText("Send a message to Planning Lead...")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Write a task instruction...")).not.toBeInTheDocument();
  });
});
