import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildEffectiveWorkflowPack } from "./effective-pack.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
      cost_profile_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `
      INSERT INTO workflow_packs (
        key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
        output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "report",
    "Report",
    1,
    "{}",
    '{"mode":"reporting","audience":"exec"}',
    '{"requireSections":["summary"]}',
    '{"sections":["summary","body"]}',
    '["report","brief"]',
    '{"maxRounds":2}',
    1,
    1,
  );
  return db;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("effective workflow pack", () => {
  it("file override를 shallow merge로 적용한다", () => {
    const db = createDb();
    const projectDir = createTempDir("claw-effective-pack-merge-");
    try {
      fs.writeFileSync(
        path.join(projectDir, ".claw-workflow.json"),
        JSON.stringify(
          {
            packOverrides: {
              report: {
                prompt_preset: { mode: "project-report" },
                routing_keywords: ["project-only"],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = buildEffectiveWorkflowPack({ db: db as any, packKey: "report", projectPath: projectDir });
      expect(result.override_applied).toBe(true);
      expect(result.override_fields).toEqual(["prompt_preset", "routing_keywords"]);
      expect(result.source).toBe("json_override");
      expect(result.project_policy_markdown).toBeNull();
      expect(result.policy_applied).toBe(false);
      expect(result.config_sources).toEqual(["claw_workflow_json"]);
      expect(result.last_known_good_applied).toBe(false);
      expect(result.last_known_good_cached_at).toBeNull();
      expect(result.pack).toMatchObject({
        key: "report",
        prompt_preset: { mode: "project-report" },
        routing_keywords: ["project-only"],
        qa_rules: { requireSections: ["summary"] },
      });
    } finally {
      db.close();
    }
  });

  it("projectPath가 없으면 DB pack 그대로 반환한다", () => {
    const db = createDb();
    try {
      const result = buildEffectiveWorkflowPack({ db: db as any, packKey: "report", projectPath: null });
      expect(result.override_applied).toBe(false);
      expect(result.override_fields).toEqual([]);
      expect(result.source).toBe("db");
      expect(result.project_policy_markdown).toBeNull();
      expect(result.policy_applied).toBe(false);
      expect(result.config_sources).toEqual([]);
      expect(result.last_known_good_applied).toBe(false);
      expect(result.last_known_good_cached_at).toBeNull();
      expect(result.pack).toMatchObject({
        key: "report",
        prompt_preset: { mode: "reporting", audience: "exec" },
      });
    } finally {
      db.close();
    }
  });

  it("WORKFLOW.md override와 policyMarkdown 정보를 함께 반환한다", () => {
    const db = createDb();
    const projectDir = createTempDir("claw-effective-pack-workflow-md-");
    try {
      fs.writeFileSync(
        path.join(projectDir, "WORKFLOW.md"),
        `---
packOverrides:
  report:
    prompt_preset:
      mode: workflow-report
---

Repository policy for development only.
`,
        "utf8",
      );

      const result = buildEffectiveWorkflowPack({ db: db as any, packKey: "report", projectPath: projectDir });
      expect(result.override_applied).toBe(true);
      expect(result.source).toBe("workflow_md_override");
      expect(result.project_policy_markdown).toBe("Repository policy for development only.");
      expect(result.policy_applied).toBe(false);
      expect(result.config_sources).toEqual(["workflow_md"]);
      expect(result.last_known_good_applied).toBe(false);
      expect(result.last_known_good_cached_at).toBeNull();
      expect(result.pack).toMatchObject({
        key: "report",
        prompt_preset: { mode: "workflow-report" },
      });
    } finally {
      db.close();
    }
  });

  it("파일 파싱 실패 시 cached override를 effective pack에 유지한다", () => {
    const db = createDb();
    const projectDir = createTempDir("claw-effective-pack-cache-");
    try {
      fs.writeFileSync(
        path.join(projectDir, ".claw-workflow.json"),
        JSON.stringify(
          {
            packOverrides: {
              report: {
                prompt_preset: { mode: "cached-report" },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      buildEffectiveWorkflowPack({ db: db as any, packKey: "report", projectPath: projectDir });

      fs.writeFileSync(path.join(projectDir, ".claw-workflow.json"), "{ invalid json", "utf8");
      const result = buildEffectiveWorkflowPack({ db: db as any, packKey: "report", projectPath: projectDir });
      expect(result.override_applied).toBe(true);
      expect(result.pack).toMatchObject({
        prompt_preset: { mode: "cached-report" },
      });
      expect(result.last_known_good_applied).toBe(true);
      expect(result.last_known_good_cached_at).not.toBeNull();
      expect(result.warnings).toContain(".claw-workflow.json parse failed, falling back to global");
      expect(result.warnings).toContain("last-known-good applied from settings cache");
    } finally {
      db.close();
    }
  });
});
