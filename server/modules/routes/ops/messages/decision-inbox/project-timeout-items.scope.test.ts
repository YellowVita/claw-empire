import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { createProjectAndTimeoutDecisionItems } from "./project-timeout-items.ts";
import type { ProjectReviewDecisionState } from "./types.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      department_id TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      project_path TEXT,
      default_pack_key TEXT NOT NULL DEFAULT 'development'
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      updated_at INTEGER,
      created_at INTEGER,
      status TEXT,
      project_id TEXT,
      source_task_id TEXT
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      title TEXT,
      status TEXT,
      target_department_id TEXT,
      orchestration_phase TEXT
    );

    CREATE TABLE meeting_minutes (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      meeting_type TEXT,
      status TEXT,
      round INTEGER,
      started_at INTEGER,
      created_at INTEGER,
      completed_at INTEGER
    );

    CREATE TABLE task_logs (
      task_id TEXT,
      kind TEXT,
      message TEXT,
      created_at INTEGER
    );

    CREATE TABLE task_run_sheets (
      task_id TEXT PRIMARY KEY,
      workflow_pack_key TEXT NOT NULL DEFAULT 'development',
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'review',
      summary_markdown TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE project_review_decision_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      snapshot_hash TEXT,
      event_type TEXT,
      summary TEXT,
      selected_options_json TEXT,
      note TEXT,
      task_id TEXT,
      meeting_id TEXT,
      created_at INTEGER
    );
  `);
  return db;
}

describe("project-timeout-items scope reset", () => {
  it("resets stale foreign planner agent before rebuilding project review card", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          report: {
            departments: [{ id: "planning" }],
            agents: [{ id: "report-seed-1", department_id: "planning" }],
          },
        }),
      );
      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("planning-global", "planning");
      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("report-seed-1", "planning");
      db.prepare("INSERT INTO projects (id, name, project_path, default_pack_key) VALUES (?, ?, ?, ?)").run(
        "proj-1",
        "Scoped Project",
        "C:/work/scoped",
        "development",
      );
      db.prepare(
        "INSERT INTO tasks (id, title, updated_at, created_at, status, project_id, source_task_id) VALUES (?, ?, ?, ?, 'review', ?, NULL)",
      ).run("task-1", "Review task", 1000, 900, "proj-1");

      let decisionState: ProjectReviewDecisionState | null = {
        project_id: "proj-1",
        snapshot_hash: "snap-1",
        status: "ready",
        planner_summary: "old summary",
        planner_agent_id: "report-seed-1",
        planner_agent_name: "Foreign Planner",
        created_at: 1000,
        updated_at: 1000,
      };

      const upsertProjectReviewDecisionState = vi.fn(
        (
          projectId: string,
          snapshotHash: string,
          status: ProjectReviewDecisionState["status"],
          plannerSummary: string | null,
          plannerAgentId: string | null,
          plannerAgentName: string | null,
        ) => {
          decisionState = {
            project_id: projectId,
            snapshot_hash: snapshotHash,
            status,
            planner_summary: plannerSummary,
            planner_agent_id: plannerAgentId,
            planner_agent_name: plannerAgentName,
            created_at: 1000,
            updated_at: 2000,
          };
        },
      );
      const queueProjectReviewPlanningConsolidation = vi.fn();

      const items = createProjectAndTimeoutDecisionItems({
        db,
        nowMs: () => 2000,
        getPreferredLanguage: () => "ko",
        pickL: (pool: unknown, lang: string) => {
          const localized = pool as Record<string, string[]>;
          return localized[lang]?.[0] ?? localized.en?.[0] ?? localized.ko?.[0] ?? "";
        },
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        buildProjectReviewSnapshotHash: () => "snap-1",
        getProjectReviewDecisionState: () => decisionState,
        upsertProjectReviewDecisionState,
        resolvePlanningLeadMeta: (_lang: string, _scope, state) => ({
          agent_id: state?.planner_agent_id ?? null,
          agent_name: state?.planner_agent_name ?? "Planning Lead",
          agent_name_ko: state?.planner_agent_name ?? "기획팀장",
          agent_avatar: "lead",
        }),
        formatPlannerSummaryForDisplay: (text: string) => text,
        queueProjectReviewPlanningConsolidation,
        PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX: "Decision inbox:",
      }).buildProjectReviewDecisionItems();

      expect(upsertProjectReviewDecisionState).toHaveBeenCalledWith("proj-1", "snap-1", "collecting", null, null, null);
      expect(queueProjectReviewPlanningConsolidation).toHaveBeenCalledWith(
        "proj-1",
        "Scoped Project",
        "C:/work/scoped",
        "snap-1",
        "ko",
      );
      expect(items[0]?.agent_id ?? null).toBeNull();
      expect(items[0]?.summary).toContain("기획팀장 의견 취합중");
    } finally {
      db.close();
    }
  });

  it("shows blocked project review status when remediation subtasks are still unfinished", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, name, project_path, default_pack_key) VALUES (?, ?, ?, ?)").run(
        "proj-1",
        "Scoped Project",
        "C:/work/scoped",
        "development",
      );
      db.prepare(
        "INSERT INTO tasks (id, title, updated_at, created_at, status, project_id, source_task_id) VALUES (?, ?, ?, ?, 'review', ?, NULL)",
      ).run("task-1", "Review task", 3000, 900, "proj-1");
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, status, target_department_id, orchestration_phase) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("sub-1", "task-1", "[검토보완] 개발 보완", "blocked", "dev", "foreign_collab");
      db.prepare(
        "INSERT INTO project_review_decision_events (project_id, snapshot_hash, event_type, summary, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "proj-1",
        "snap-2",
        "planning_summary",
        "기획팀장 요약",
        null,
        2100,
      );
      db.prepare(
        "INSERT INTO project_review_decision_events (project_id, snapshot_hash, event_type, summary, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "proj-1",
        "snap-2",
        "start_review_meeting_blocked",
        "Review hold",
        "Review hold: waiting for 1 unfinished subtasks",
        2200,
      );

      const decisionState: ProjectReviewDecisionState = {
        project_id: "proj-1",
        snapshot_hash: "snap-2",
        status: "collecting",
        planner_summary: null,
        planner_agent_id: "planning-global",
        planner_agent_name: "Planning Lead",
        created_at: 2000,
        updated_at: 2200,
      };

      const items = createProjectAndTimeoutDecisionItems({
        db,
        nowMs: () => 2300,
        getPreferredLanguage: () => "ko",
        pickL: (pool: unknown, lang: string) => {
          const localized = pool as Record<string, string[]>;
          return localized[lang]?.[0] ?? localized.en?.[0] ?? localized.ko?.[0] ?? "";
        },
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        buildProjectReviewSnapshotHash: () => "snap-2",
        getProjectReviewDecisionState: () => decisionState,
        upsertProjectReviewDecisionState: vi.fn(),
        resolvePlanningLeadMeta: (_lang: string, _scope, state) => ({
          agent_id: state?.planner_agent_id ?? null,
          agent_name: state?.planner_agent_name ?? "Planning Lead",
          agent_name_ko: state?.planner_agent_name ?? "기획팀장",
          agent_avatar: "lead",
        }),
        formatPlannerSummaryForDisplay: (text: string) => text,
        queueProjectReviewPlanningConsolidation: vi.fn(),
        PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX: "Decision inbox:",
      }).buildProjectReviewDecisionItems();

      expect(items[0]?.decision_status).toBe("blocked");
      expect(items[0]?.summary).toContain("기획팀장 의견 취합 완료");
      expect(items[0]?.summary).toContain("미완료 서브태스크 1건");
      expect(items[0]?.options).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not show project review card while a root task is repairing merge conflicts", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, name, project_path, default_pack_key) VALUES (?, ?, ?, ?)").run(
        "proj-1",
        "Scoped Project",
        "C:/work/scoped",
        "development",
      );
      db.prepare(
        "INSERT INTO tasks (id, title, updated_at, created_at, status, project_id, source_task_id) VALUES (?, ?, ?, ?, 'review', ?, NULL)",
      ).run("task-1", "Review task", 3000, 900, "proj-1");
      db.prepare(
        "INSERT INTO task_run_sheets (task_id, workflow_pack_key, stage, status, summary_markdown, snapshot_json, created_at, updated_at) VALUES (?, 'development', ?, 'review', '', '{}', 1, 1)",
      ).run("task-1", "merge_conflict_resolution");

      const decisionState: ProjectReviewDecisionState = {
        project_id: "proj-1",
        snapshot_hash: "snap-2",
        status: "ready",
        planner_summary: "기획팀장 요약",
        planner_agent_id: "planning-global",
        planner_agent_name: "Planning Lead",
        created_at: 2000,
        updated_at: 2200,
      };

      const items = createProjectAndTimeoutDecisionItems({
        db,
        nowMs: () => 2300,
        getPreferredLanguage: () => "ko",
        pickL: (pool: unknown, lang: string) => {
          const localized = pool as Record<string, string[]>;
          return localized[lang]?.[0] ?? localized.en?.[0] ?? localized.ko?.[0] ?? "";
        },
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        buildProjectReviewSnapshotHash: () => "snap-2",
        getProjectReviewDecisionState: () => decisionState,
        upsertProjectReviewDecisionState: vi.fn(),
        resolvePlanningLeadMeta: (_lang: string, _scope, state) => ({
          agent_id: state?.planner_agent_id ?? null,
          agent_name: state?.planner_agent_name ?? "Planning Lead",
          agent_name_ko: state?.planner_agent_name ?? "기획팀장",
          agent_avatar: "lead",
        }),
        formatPlannerSummaryForDisplay: (text: string) => text,
        queueProjectReviewPlanningConsolidation: vi.fn(),
        PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX: "Decision inbox:",
      }).buildProjectReviewDecisionItems();

      expect(items).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("shows blocked project review status when owner_integrate subtasks are still unfinished", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, name, project_path, default_pack_key) VALUES (?, ?, ?, ?)").run(
        "proj-1",
        "Scoped Project",
        "C:/work/scoped",
        "development",
      );
      db.prepare(
        "INSERT INTO tasks (id, title, updated_at, created_at, status, project_id, source_task_id) VALUES (?, ?, ?, ?, 'review', ?, NULL)",
      ).run("task-1", "Review task", 3000, 900, "proj-1");
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, status, target_department_id, orchestration_phase) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("sub-1", "task-1", "[검토보완] 반영 결과 통합 및 재검토 제출", "pending", null, "owner_integrate");
      db.prepare(
        "INSERT INTO project_review_decision_events (project_id, snapshot_hash, event_type, summary, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "proj-1",
        "snap-3",
        "planning_summary",
        "기획팀장 요약",
        null,
        2100,
      );

      const decisionState: ProjectReviewDecisionState = {
        project_id: "proj-1",
        snapshot_hash: "snap-3",
        status: "ready",
        planner_summary: "기획팀장 요약",
        planner_agent_id: "planning-global",
        planner_agent_name: "Planning Lead",
        created_at: 2000,
        updated_at: 2200,
      };

      const items = createProjectAndTimeoutDecisionItems({
        db,
        nowMs: () => 2300,
        getPreferredLanguage: () => "ko",
        pickL: (pool: unknown, lang: string) => {
          const localized = pool as Record<string, string[]>;
          return localized[lang]?.[0] ?? localized.en?.[0] ?? localized.ko?.[0] ?? "";
        },
        l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
        buildProjectReviewSnapshotHash: () => "snap-3",
        getProjectReviewDecisionState: () => decisionState,
        upsertProjectReviewDecisionState: vi.fn(),
        resolvePlanningLeadMeta: (_lang: string, _scope, state) => ({
          agent_id: state?.planner_agent_id ?? null,
          agent_name: state?.planner_agent_name ?? "Planning Lead",
          agent_name_ko: state?.planner_agent_name ?? "기획팀장",
          agent_avatar: "lead",
        }),
        formatPlannerSummaryForDisplay: (text: string) => text,
        queueProjectReviewPlanningConsolidation: vi.fn(),
        PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX: "Decision inbox:",
      }).buildProjectReviewDecisionItems();

      expect(items[0]?.decision_status).toBe("blocked");
      expect(items[0]?.summary).toContain("미완료 서브태스크 1건");
      expect(items[0]?.options).toEqual([]);
    } finally {
      db.close();
    }
  });
});
