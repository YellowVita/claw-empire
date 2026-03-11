import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRuntimeWorkflowPackPromptBlock,
  buildRuntimeWorkflowPackPromptSections,
  resolveRuntimeWorkflowPack,
} from "./runtime-effective-pack.ts";

describe("runtime-effective-pack", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
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
    db.prepare(`
      INSERT INTO workflow_packs (
        key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
        output_template_json, routing_keywords_json, cost_profile_json
      )
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      "report",
      "Report",
      JSON.stringify({}),
      JSON.stringify({ mode: "db" }),
      JSON.stringify({ require_sections: ["summary", "risks"] }),
      JSON.stringify({ sections: ["summary", "changes", "risks"] }),
      JSON.stringify(["status", "summary"]),
      JSON.stringify({ priority: "medium", budget: { max_minutes: 30 } }),
    );
  });

  afterEach(() => {
    db.close();
  });

  it("snapshot을 우선 사용한다", () => {
    const result = resolveRuntimeWorkflowPack({
      db,
      workflowPackKey: "report",
      workflowMetaJson: JSON.stringify({
        effective_pack_snapshot: {
          key: "report",
          name: "Report",
          enabled: true,
          input_schema: {},
          prompt_preset: { mode: "snapshot" },
          qa_rules: { require_sections: ["summary"] },
          output_template: { sections: ["summary"] },
          routing_keywords: ["ignored"],
          cost_profile: { priority: "high" },
        },
      }),
    });

    expect(result.source).toBe("snapshot");
    expect(result.pack?.prompt_preset).toEqual({ mode: "snapshot" });
  });

  it("malformed workflow_meta_json이면 DB pack으로 폴백한다", () => {
    const result = resolveRuntimeWorkflowPack({
      db,
      workflowPackKey: "report",
      workflowMetaJson: "{bad json",
    });

    expect(result.source).toBe("db_fallback");
    expect(result.pack?.qa_rules).toEqual({ require_sections: ["summary", "risks"] });
  });

  it("routing_keywords를 제외하고 deterministic 하게 렌더한다", () => {
    const workflowMetaJson = JSON.stringify({
      effective_pack_snapshot: {
        key: "report",
        name: "Report",
        enabled: true,
        input_schema: {},
        prompt_preset: { z: 1, a: 2 },
        qa_rules: { allow_partial: false, require_sections: ["summary"] },
        output_template: { sections: ["summary", "changes"] },
        routing_keywords: ["do-not-render"],
        cost_profile: { max_minutes: 15 },
      },
    });
    const first = buildRuntimeWorkflowPackPromptBlock({
      db,
      workflowPackKey: "report",
      workflowMetaJson,
    });
    const second = buildRuntimeWorkflowPackPromptBlock({
      db,
      workflowPackKey: "report",
      workflowMetaJson,
    });

    expect(first).toBe(second);
    expect(first).toContain("authoritative source");
    expect(first).toContain("[Prompt Preset]");
    expect(first).not.toContain("routing_keywords");
    expect(first).not.toContain("do-not-render");
  });

  it("prompt budget 초과 시 낮은 우선순위 필드부터 생략한다", () => {
    const largeText = "X".repeat(1200);
    const block = buildRuntimeWorkflowPackPromptBlock({
      db,
      workflowPackKey: "report",
      workflowMetaJson: JSON.stringify({
        effective_pack_snapshot: {
          key: "report",
          name: "Report",
          enabled: true,
          input_schema: {},
          prompt_preset: { headline: largeText },
          qa_rules: { policy: largeText },
          output_template: { sections: [largeText] },
          cost_profile: { note: largeText },
        },
      }),
      maxChars: 900,
    });

    expect(block).toContain("Omitted due to prompt budget");
    expect(block).toContain("cost_profile");
    expect(block).not.toContain("[Cost Profile]");
  });

  it("generic guidance와 snapshot block을 함께 구성한다", () => {
    const sections = buildRuntimeWorkflowPackPromptSections({
      db,
      workflowPackKey: "report",
      workflowMetaJson: JSON.stringify({
        effective_pack_snapshot: {
          key: "report",
          name: "Report",
          enabled: true,
          input_schema: {},
          prompt_preset: { mode: "snapshot" },
          qa_rules: { require_sections: ["summary"] },
          output_template: {},
          cost_profile: {},
        },
      }),
      workflowPackGuidance: "Generic report guidance.",
    });
    const prompt = sections.join("\n");

    expect(prompt).toContain("[Workflow Pack Execution Rules]");
    expect(prompt).toContain("Generic report guidance.");
    expect(prompt).toContain("[Workflow Pack Effective Configuration]");
    expect(prompt).toContain("follow this block");
  });

  it("development pack에서만 project workflow policy block을 포함한다", () => {
    const developmentSections = buildRuntimeWorkflowPackPromptSections({
      db,
      workflowPackKey: "development",
      projectWorkflowPolicyMarkdown: "# Repo Policy\n\n- Run tests first.",
    });
    const reportSections = buildRuntimeWorkflowPackPromptSections({
      db,
      workflowPackKey: "report",
      projectWorkflowPolicyMarkdown: "# Repo Policy\n\n- Run tests first.",
    });

    expect(developmentSections.join("\n")).toContain("[Project Workflow Policy]");
    expect(developmentSections.join("\n")).toContain("Run tests first.");
    expect(reportSections.join("\n")).not.toContain("[Project Workflow Policy]");
  });
});
