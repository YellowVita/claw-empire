import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import TaskReportPopup from "./TaskReportPopup";

const baseReport = {
  task: {
    id: "task-1",
    title: "Ship feature",
    description: null,
    department_id: "planning",
    assigned_agent_id: "agent-1",
    status: "done",
    project_path: "/tmp/project",
    workflow_pack_key: "development",
    development_handoff: {
      state: "done",
      updated_at: 2000,
      status_snapshot: "done",
      pending_retry: false,
      pr_gate_status: "blocked",
      pr_url: "https://github.com/acme/repo/pull/12",
      summary: "Blocked by PR feedback gate",
    },
    created_at: 1000,
    completed_at: 2000,
    agent_name: "Ari",
    agent_name_ko: "아리",
    agent_role: "team_leader",
    dept_name: "Planning",
    dept_name_ko: "기획팀",
  },
  logs: [
    { kind: "system", message: "Final branch verification: passed (ref=main, commits=1, files=1)", created_at: 1500 },
  ],
  subtasks: [],
  meeting_minutes: [],
  quality: {
    items: [
      {
        id: "quality-1",
        task_id: "task-1",
        kind: "validation",
        label: "Video verified",
        details: null,
        required: 1,
        status: "passed",
        evidence_markdown: null,
        source: "system",
        sort_order: 0,
        created_at: 1000,
        updated_at: 1000,
        completed_at: 1700,
      },
    ],
    summary: {
      required_total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      blocked_review: false,
    },
    runs: [
      {
        id: "quality-run-1",
        task_id: "task-1",
        quality_item_id: null,
        run_type: "artifact_check",
        name: "video gate",
        command: null,
        status: "passed",
        exit_code: 0,
        summary: "Video artifact verified",
        output_excerpt: null,
        metadata: { path: "/tmp/project/video_output/final.mp4" },
        started_at: 1600,
        completed_at: 1700,
        created_at: 1700,
      },
    ],
    artifacts: [
      {
        id: "artifact-1",
        task_id: "task-1",
        quality_item_id: null,
        kind: "video",
        title: "final.mp4",
        path: "/tmp/project/video_output/final.mp4",
        mime: "video/mp4",
        size_bytes: 1024,
        source: "video_gate",
        metadata: { verified: true },
        created_at: 1700,
      },
    ],
  },
  planning_summary: {
    title: "Planning Lead Consolidated Summary",
    content: "Summary body",
    source_task_id: "task-1",
    source_agent_name: "Ari",
    source_department_name: "Planning",
    generated_at: 1600,
    documents: [],
  },
  execution: {
    summary: {
      retry_count: 2,
      last_retry_reason: "hard_timeout",
      pending_retry: true,
      hook_failures: 1,
      project_hook_override_used: true,
      last_event_at: 1700,
    },
    events: [
      {
        id: "event-1",
        task_id: "task-1",
        category: "retry",
        action: "queued",
        status: "warning",
        message: "Automatic retry scheduled",
        details: { reason: "hard_timeout" },
        attempt_count: 2,
        hook_source: null,
        duration_ms: null,
        created_at: 1700,
      },
    ],
  },
  development_run_sheet: {
    task_id: "task-1",
    workflow_pack_key: "development",
    stage: "done",
    status: "done",
    summary_markdown: "# Development Run Sheet\n\n- Stage: done",
    snapshot: {
      current_plan: {
        title: "Ship feature",
        description: "Implement execution observability",
        latest_report: "Final report",
        project_path: "/tmp/project",
      },
      reproduction: {
        status: "not_recorded",
        evidence: [],
      },
      implementation: {
        result_summary: "Implemented",
        latest_report: "Final report",
        diff_summary: "M src/app.ts",
        log_highlights: [],
      },
      validation: {
        required_total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        blocked_review: false,
        pending_retry: false,
        recent_runs: [],
        artifacts: [],
      },
      review_checklist: {
        entered_review: true,
        blocked_review: false,
        waiting_on_subtasks: false,
        waiting_on_child_reviews: false,
        pending_retry: false,
        merge_status: "merged",
        approval_audit: {
          approved_at: 1985,
          approval_source: "review_consensus",
          updated_at: 2000,
        },
        merge_audit: {
          auto_commit_sha: "abcdef1234567890",
          post_merge_head_sha: "fedcba0987654321",
          target_branch: "dev",
          updated_at: 2000,
        },
        pr_feedback_gate: {
          applicable: true,
          status: "blocked",
          pr_url: "https://github.com/acme/repo/pull/12",
          unresolved_thread_count: 2,
          change_requests_count: 1,
          failing_check_count: 1,
          pending_check_count: 0,
          ignored_check_count: 2,
          ignored_check_names: ["optional / preview", "optional / smoke"],
          blocking_reasons: ["Unresolved review threads: 2", "Failing checks: 1"],
          checked_at: 1990,
        },
      },
      handoff: {
        status: "done",
        summary: "Done",
      },
      timeline: {
        created_at: 1000,
        started_at: 1100,
        review_entered_at: 1500,
        completed_at: 2000,
        updated_at: 2000,
      },
    },
    updated_at: 2000,
    synthetic: false,
  },
  team_reports: [],
  project: {
    root_task_id: "task-1",
    project_name: "Project",
    project_path: "/tmp/project",
    core_goal: "Goal",
  },
};

describe("TaskReportPopup", () => {
  it("shows final branch verification logs in the report popup", () => {
    render(
      <I18nProvider language="en">
        <TaskReportPopup
          report={baseReport as any}
          agents={[{ id: "agent-1", name: "Ari", name_ko: "아리", avatar_emoji: "A" } as any]}
          departments={[{ id: "planning", name: "Planning", name_ko: "기획팀", color: "#00aa88", icon: "P" } as any]}
          uiLanguage="en"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Final Branch Verification")).toBeInTheDocument();
    expect(screen.getByText(/Final branch verification: passed/)).toBeInTheDocument();
  });

  it("keeps a sprite avatar when the assigned agent is missing from the active agent list", () => {
    render(
      <I18nProvider language="en">
        <TaskReportPopup report={baseReport as any} agents={[]} departments={[]} uiLanguage="en" onClose={() => {}} />
      </I18nProvider>,
    );

    expect(screen.getByAltText("Ari")).toBeInTheDocument();
  });

  it("shows execution observability summary when execution data exists", () => {
    render(
      <I18nProvider language="en">
        <TaskReportPopup
          report={baseReport as any}
          agents={[{ id: "agent-1", name: "Ari", name_ko: "아리", avatar_emoji: "A" } as any]}
          departments={[{ id: "planning", name: "Planning", name_ko: "기획팀", color: "#00aa88", icon: "P" } as any]}
          uiLanguage="en"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Execution Observability")).toBeInTheDocument();
    expect(screen.getByText("hard_timeout")).toBeInTheDocument();
    expect(screen.getByText("Automatic retry scheduled")).toBeInTheDocument();
  });

  it("shows quality evidence when quality runs and artifacts exist", () => {
    render(
      <I18nProvider language="en">
        <TaskReportPopup
          report={baseReport as any}
          agents={[{ id: "agent-1", name: "Ari", name_ko: "아리", avatar_emoji: "A" } as any]}
          departments={[{ id: "planning", name: "Planning", name_ko: "기획팀", color: "#00aa88", icon: "P" } as any]}
          uiLanguage="en"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Quality Evidence")).toBeInTheDocument();
    expect(screen.getByText("Recent Quality Runs")).toBeInTheDocument();
    expect(screen.getByText("Video artifact verified")).toBeInTheDocument();
    expect(screen.getByText("Captured Artifacts")).toBeInTheDocument();
    expect(screen.getByText("final.mp4")).toBeInTheDocument();
  });

  it("shows development run sheet when available", () => {
    render(
      <I18nProvider language="en">
        <TaskReportPopup
          report={baseReport as any}
          agents={[{ id: "agent-1", name: "Ari", name_ko: "아리", avatar_emoji: "A" } as any]}
          departments={[{ id: "planning", name: "Planning", name_ko: "기획팀", color: "#00aa88", icon: "P" } as any]}
          uiLanguage="en"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Development Run Sheet")).toBeInTheDocument();
    expect(screen.getByText("Development Handoff")).toBeInTheDocument();
    expect(screen.getByText("Blocked by PR feedback gate")).toBeInTheDocument();
    expect(screen.getByText("Stored canonical brief")).toBeInTheDocument();
    expect(screen.getByText(/Stage: done/)).toBeInTheDocument();
    expect(screen.getAllByText("blocked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("https://github.com/acme/repo/pull/12").length).toBeGreaterThan(0);
    expect(screen.getByText(/Unresolved review threads: 2/)).toBeInTheDocument();
    expect(screen.getByText("Ignored Checks")).toBeInTheDocument();
    expect(screen.getByText("optional / preview | optional / smoke")).toBeInTheDocument();
  });

  it("shows approval and merge audit details when present", () => {
    render(
      <I18nProvider language="en">
        <TaskReportPopup
          report={baseReport as any}
          agents={[{ id: "agent-1", name: "Ari", name_ko: "아리", avatar_emoji: "A" } as any]}
          departments={[{ id: "planning", name: "Planning", name_ko: "기획팀", color: "#00aa88", icon: "P" } as any]}
          uiLanguage="en"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Approval and Merge Audit")).toBeInTheDocument();
    expect(screen.getByText("review_consensus")).toBeInTheDocument();
    expect(screen.getByText("abcdef123456")).toBeInTheDocument();
    expect(screen.getByText("fedcba098765")).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
  });
});
