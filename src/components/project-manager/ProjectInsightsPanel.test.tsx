import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowPackEffectivePreview } from "../../api";
import type { Project } from "../../types";
import ProjectInsightsPanel from "./ProjectInsightsPanel";
import type { I18nTextMap } from "./types";

function t(messages: I18nTextMap): string {
  return messages.en ?? messages.ko ?? messages.ja ?? messages.zh ?? Object.values(messages)[0] ?? "";
}

describe("ProjectInsightsPanel", () => {
  it("프로젝트 pack detection 정보를 표시한다", () => {
    const preview: WorkflowPackEffectivePreview = {
      pack: {
        key: "report",
        name: "Report",
        enabled: true,
        input_schema: {},
        prompt_preset: {},
        qa_rules: {},
        output_template: {},
        routing_keywords: [],
        cost_profile: {},
      },
      override_applied: true,
      override_fields: ["prompt_preset", "routing_keywords"],
      source: "json_override",
      project_policy_markdown: null,
      policy_applied: false,
      config_sources: ["claw_workflow_json"],
      warnings: [],
    };
    const project: Project = {
      id: "project-1",
      name: "Project One",
      project_path: "/tmp/project-one",
      core_goal: "Ship feature",
      default_pack_key: "development",
      detected_workflow_pack_key: "report",
      workflow_pack_source: "file_default",
      workflow_pack_override_applied: true,
      workflow_pack_override_fields: ["prompt_preset", "routing_keywords"],
      workflow_pack_preview_key: "report",
      assignment_mode: "auto",
      assigned_agent_ids: [],
      last_used_at: null,
      created_at: 1,
      updated_at: 1,
      github_repo: null,
    };

    render(
      <ProjectInsightsPanel
        t={t}
        selectedProject={project}
        loadingDetail={false}
        isCreating={false}
        groupedTaskCards={[]}
        sortedReports={[]}
        sortedDecisionEvents={[]}
        getDecisionEventLabel={() => ""}
        handleOpenTaskDetail={vi.fn(async () => {})}
        handlePreviewWorkflowPack={vi.fn(async () => preview)}
      />,
    );

    expect(
      screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("DB Default Pack: development") === true),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("Detected File Pack: report") === true),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("Current Source: file_default") === true),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("Override Fields: prompt_preset, routing_keywords") === true),
    ).toBeInTheDocument();
    expect(screen.getByText("Effective Pack Preview")).toBeInTheDocument();
  });
});
