import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../types";
import ProjectInsightsPanel from "./ProjectInsightsPanel";
import type { I18nTextMap } from "./types";

function t(messages: I18nTextMap): string {
  return messages.en ?? messages.ko ?? messages.ja ?? messages.zh ?? Object.values(messages)[0] ?? "";
}

describe("ProjectInsightsPanel", () => {
  it("프로젝트 pack detection 정보를 표시한다", () => {
    const project: Project = {
      id: "project-1",
      name: "Project One",
      project_path: "/tmp/project-one",
      core_goal: "Ship feature",
      default_pack_key: "development",
      detected_workflow_pack_key: "report",
      workflow_pack_source: "file_default",
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
  });
});
