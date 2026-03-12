import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectDevelopmentWorkflowHealth, WorkflowPackEffectivePreview } from "../../api";
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
      last_known_good_applied: false,
      last_known_good_cached_at: null,
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
        developmentWorkflowHealth={null}
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

  it("effective preview에서 last-known-good 상태를 표시한다", async () => {
    const preview: WorkflowPackEffectivePreview = {
      pack: {
        key: "development",
        name: "Development",
        enabled: true,
        input_schema: {},
        prompt_preset: {},
        qa_rules: {},
        output_template: {},
        routing_keywords: [],
        cost_profile: {},
      },
      override_applied: false,
      override_fields: [],
      source: "db",
      project_policy_markdown: null,
      policy_applied: false,
      config_sources: ["workflow_md"],
      last_known_good_applied: true,
      last_known_good_cached_at: 1700000000000,
      warnings: ["last-known-good applied from settings cache"],
    };
    const project: Project = {
      id: "project-2",
      name: "Project Two",
      project_path: "/tmp/project-two",
      core_goal: "Keep workflow stable",
      default_pack_key: "development",
      detected_workflow_pack_key: "development",
      workflow_pack_source: "file_default",
      workflow_pack_override_applied: false,
      workflow_pack_override_fields: [],
      workflow_pack_preview_key: "development",
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
        developmentWorkflowHealth={null}
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

    fireEvent.click(screen.getByText("Effective Pack Preview"));
    expect(await screen.findByText("last-known-good active")).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes("Cached At:"))).toBeInTheDocument();
    expect(screen.getByText("last-known-good applied from settings cache")).toBeInTheDocument();
  });

  it("development workflow health 카드를 렌더링한다", () => {
    const project: Project = {
      id: "project-3",
      name: "Project Three",
      project_path: "/tmp/project-three",
      core_goal: "Watch workflow health",
      default_pack_key: "development",
      detected_workflow_pack_key: "development",
      workflow_pack_source: "project_default",
      workflow_pack_override_applied: false,
      workflow_pack_override_fields: [],
      workflow_pack_preview_key: "development",
      assignment_mode: "auto",
      assigned_agent_ids: [],
      last_used_at: null,
      created_at: 1,
      updated_at: 1,
      github_repo: null,
    };
    const health: ProjectDevelopmentWorkflowHealth = {
      contract_status: {
        preview_pack_key: "development",
        source: "merged_file_override",
        override_applied: true,
        last_known_good_applied: true,
        last_known_good_cached_at: 1700000000000,
        warnings: ["last-known-good applied from settings cache", "WORKFLOW.md parse failed"],
      },
      coverage: {
        root_task_total: 4,
        stored_run_sheet_count: 2,
        synthetic_queued_count: 1,
        missing_persisted_run_sheet_count: 1,
        owner_prep_blocked_count: 1,
        owner_prep_blocker_total: 3,
      },
      handoff_states: [
        { state: "human_review", count: 1 },
        { state: "queued", count: 2 },
      ],
      pr_gate: {
        blocked_count: 1,
        passed_count: 2,
        skipped_count: 0,
        never_checked_count: 1,
        ignored_optional_checks_total: 3,
      },
      attention_tasks: [
        {
          task_id: "task-1",
          title: "Blocked task",
          status: "review",
          handoff_state: "human_review",
          run_sheet_stage: "rework",
          pr_gate_status: "blocked",
          owner_prep_blocker_count: 3,
          pending_retry: false,
          updated_at: 1700000000000,
        },
      ],
    };

    render(
      <ProjectInsightsPanel
        t={t}
        selectedProject={project}
        developmentWorkflowHealth={health}
        loadingDetail={false}
        isCreating={false}
        groupedTaskCards={[]}
        sortedReports={[]}
        sortedDecisionEvents={[]}
        getDecisionEventLabel={() => ""}
        handleOpenTaskDetail={vi.fn(async () => {})}
        handlePreviewWorkflowPack={vi.fn(async () => {
          throw new Error("not used");
        })}
      />,
    );

    expect(screen.getByText("Development Workflow Health")).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes("Root Tasks: 4"))).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes("Owner Prep Blocked Tasks: 1"))).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes("Owner Prep Blockers: 3"))).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes("Ignored Optional Checks: 3"))).toBeInTheDocument();
    expect(screen.getByText("Blocked task")).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes("Owner prep blockers: 3"))).toBeInTheDocument();
    expect(screen.getByText("last-known-good applied from settings cache")).toBeInTheDocument();
  });
});
