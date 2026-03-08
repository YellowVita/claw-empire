import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ApiSettingsTab from "./ApiSettingsTab";
import type { ApiStateBundle } from "./types";

function t(messages: Record<string, string>): string {
  return messages.en ?? messages.ko ?? messages.ja ?? messages.zh ?? Object.values(messages)[0] ?? "";
}

function createApiState(): ApiStateBundle {
  return {
    apiProviders: [
      {
        id: "provider-1",
        name: "Primary OpenAI",
        type: "openai",
        base_url: "https://api.openai.com/v1",
        enabled: true,
        has_api_key: true,
        models_cache: ["gpt-4o", "claude-3-7-sonnet", "gemini-2.5-pro"],
        models_cached_at: Date.now(),
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ],
    apiProvidersLoading: false,
    apiAddMode: false,
    apiEditingId: null,
    apiForm: {
      name: "",
      type: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "",
    },
    apiSaving: false,
    apiTesting: null,
    apiTestResult: {},
    apiModelsExpanded: { "provider-1": true },
    apiAssignTarget: null,
    apiAssignAgents: [],
    apiAssignDepts: [],
    apiAssigning: false,
    setApiAddMode: vi.fn(),
    setApiEditingId: vi.fn(),
    setApiForm: vi.fn(),
    setApiModelsExpanded: vi.fn(),
    setApiAssignTarget: vi.fn(),
    loadApiProviders: vi.fn(async () => {}),
    handleApiProviderSave: vi.fn(async () => {}),
    handleApiProviderDelete: vi.fn(async () => {}),
    handleApiProviderTest: vi.fn(async () => {}),
    handleApiProviderToggle: vi.fn(async () => {}),
    handleApiEditStart: vi.fn(),
    handleApiModelAssign: vi.fn(async () => {}),
    handleApiAssignToAgent: vi.fn(async () => {}),
  };
}

describe("ApiSettingsTab", () => {
  it("filters expanded model lists by search query", async () => {
    const user = userEvent.setup();

    render(<ApiSettingsTab t={t} localeTag="en-US" apiState={createApiState()} />);

    const searchInput = screen.getByRole("textbox", { name: "Search models" });
    await user.type(searchInput, "claude");

    expect(screen.getByText("claude-3-7-sonnet")).toBeInTheDocument();
    expect(screen.queryByText("gpt-4o")).not.toBeInTheDocument();
    expect(screen.queryByText("gemini-2.5-pro")).not.toBeInTheDocument();
  });
});
