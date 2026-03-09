import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSubtaskDelegationPromptBuilder } from "./subtask-delegation-prompt.ts";

describe("subtask-delegation prompt workflow pack snapshot", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        project_id TEXT,
        project_path TEXT,
        department_id TEXT,
        workflow_pack_key TEXT,
        workflow_meta_json TEXT
      );
      CREATE TABLE subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        title TEXT,
        description TEXT,
        status TEXT,
        target_department_id TEXT,
        delegated_task_id TEXT,
        created_at INTEGER
      );
      CREATE TABLE departments (
        id TEXT PRIMARY KEY,
        name TEXT,
        name_ko TEXT,
        name_ja TEXT,
        name_zh TEXT,
        icon TEXT,
        color TEXT,
        description TEXT,
        prompt TEXT,
        sort_order INTEGER,
        created_at INTEGER
      );
      CREATE TABLE workflow_packs (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        input_schema_json TEXT NOT NULL,
        prompt_preset_json TEXT NOT NULL,
        qa_rules_json TEXT NOT NULL,
        output_template_json TEXT NOT NULL,
        routing_keywords_json TEXT NOT NULL,
        cost_profile_json TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO departments (id, name, name_ko, name_ja, name_zh, icon, color, description, prompt, sort_order, created_at)
       VALUES ('design', 'Design', '디자인', 'デザイン', '设计', '', '', '', '', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_packs (
        key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
        output_template_json, routing_keywords_json, cost_profile_json
      ) VALUES ('report', 'Report', 1, '{}', '{}', '{}', '{}', '[]', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, project_id, project_path, department_id, workflow_pack_key, workflow_meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-1",
      "Parent task",
      "Need final report",
      "project-1",
      "C:/workspace/project",
      "planning",
      "report",
      JSON.stringify({
        effective_pack_snapshot: {
          key: "report",
          name: "Report",
          enabled: true,
          input_schema: {},
          prompt_preset: { mode: "snapshot-report" },
          qa_rules: { require_sections: ["summary"] },
          output_template: {},
          routing_keywords: ["ignore-me"],
          cost_profile: {},
        },
      }),
    );
    db.prepare(
      `INSERT INTO subtasks (id, task_id, title, description, status, target_department_id, delegated_task_id, created_at)
       VALUES ('sub-1', 'task-1', 'Draft design summary', 'Summarize deliverables', 'pending', 'design', NULL, 1)`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("delegation prompt에 effective workflow pack block을 포함한다", () => {
    const { buildSubtaskDelegationPrompt } = createSubtaskDelegationPromptBuilder({
      db,
      l: (ko, en, ja = en, zh = en) => ({ ko, en, ja, zh }),
      pickL: (pool, lang) => pool[lang]?.[0] ?? pool.ko[0],
      resolveLang: () => "en",
      getDeptName: (deptId: string) => deptId,
      getDeptRoleConstraint: () => "Keep the design scope tight.",
      getRecentConversationContext: () => "",
      getAgentDisplayName: (agent: { name?: string }) => agent.name ?? "agent",
      buildTaskExecutionPrompt: (parts: string[]) => parts.filter(Boolean).join("\n"),
      hasExplicitWarningFixRequest: () => false,
    });

    const prompt = buildSubtaskDelegationPrompt(
      {
        id: "task-1",
        title: "Parent task",
        description: "Need final report",
        project_id: "project-1",
        project_path: "C:/workspace/project",
      },
      [
        {
          id: "sub-1",
          title: "Draft design summary",
          description: "Summarize deliverables",
        } as any,
      ],
      {
        id: "agent-1",
        name: "Designer",
        role: "senior",
      } as any,
      "design",
      "Design",
    );

    expect(prompt).toContain("[Workflow Pack Effective Configuration]");
    expect(prompt).toContain("snapshot-report");
    expect(prompt).not.toContain("ignore-me");
  });
});
