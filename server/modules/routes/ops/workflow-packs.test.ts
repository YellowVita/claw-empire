import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { registerWorkflowPackRoutes } from "./workflow-packs.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function createHarness() {
  const db = new DatabaseSync(":memory:");
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
      cost_profile_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      project_path TEXT,
      default_pack_key TEXT NOT NULL DEFAULT 'development'
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
    "development",
    "Development",
    1,
    '{"required":["project"]}',
    '{"mode":"engineering"}',
    '{"requireTestEvidence":true}',
    '{"sections":["summary"]}',
    '["fix","bug"]',
    '{"maxRounds":3}',
    1,
    1,
  );

  const getRoutes = new Map<string, RouteHandler>();
  const postRoutes = new Map<string, RouteHandler>();
  const putRoutes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      getRoutes.set(path, handler);
      return this;
    },
    post(path: string, handler: RouteHandler) {
      postRoutes.set(path, handler);
      return this;
    },
    put(path: string, handler: RouteHandler) {
      putRoutes.set(path, handler);
      return this;
    },
  };

  registerWorkflowPackRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => 1700000000000,
    normalizeTextField: (value: unknown) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    },
  });

  return { db, getRoutes, postRoutes, putRoutes };
}

describe("workflow pack import/export routes", () => {
  it("전체 export 문서를 반환한다", () => {
    const harness = createHarness();
    try {
      const handler = harness.getRoutes.get("/api/workflow-packs/export");
      const res = createFakeResponse();
      handler?.({ query: {} }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({
        version: 1,
        exported_at: 1700000000000,
        packs: [
          expect.objectContaining({
            key: "development",
            name: "Development",
            enabled: true,
            routing_keywords: ["fix", "bug"],
          }),
        ],
      });
    } finally {
      harness.db.close();
    }
  });

  it("단일 pack export는 지정 key만 반환한다", () => {
    const harness = createHarness();
    try {
      harness.db
        .prepare(
          `
            INSERT INTO workflow_packs (
              key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
              output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "report",
          "Structured Report",
          0,
          '{"required":["goal"]}',
          '{"mode":"reporting"}',
          '{"failOnMissingSections":true}',
          '{"sections":["summary"]}',
          '["report"]',
          '{"maxRounds":2}',
          1,
          1,
        );
      const handler = harness.getRoutes.get("/api/workflow-packs/export");
      const res = createFakeResponse();
      handler?.({ query: { key: "report" } }, res);

      const payload = res.payload as any;
      expect(res.statusCode).toBe(200);
      expect(payload.packs).toHaveLength(1);
      expect(payload.packs[0]?.key).toBe("report");
    } finally {
      harness.db.close();
    }
  });

  it("valid import는 기존 row를 update하고 없는 row를 insert한다", () => {
    const harness = createHarness();
    try {
      const handler = harness.postRoutes.get("/api/workflow-packs/import");
      const res = createFakeResponse();
      handler?.(
        {
          body: {
            version: 1,
            exported_at: 1700000000000,
            packs: [
              {
                key: "development",
                name: "Development Updated",
                enabled: false,
                input_schema: { required: ["instruction"] },
                prompt_preset: { mode: "engineering" },
                qa_rules: { requireTestEvidence: false },
                output_template: { sections: ["summary", "changes"] },
                routing_keywords: ["refactor"],
                cost_profile: { maxRounds: 4 },
              },
              {
                key: "report",
                name: "Structured Report",
                enabled: true,
                input_schema: { required: ["goal"] },
                prompt_preset: { mode: "reporting" },
                qa_rules: { failOnMissingSections: true },
                output_template: { sections: ["summary"] },
                routing_keywords: ["report"],
                cost_profile: { maxRounds: 2 },
              },
            ],
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({
        ok: true,
        imported: 2,
        packs: ["development", "report"],
      });
      expect(harness.db.prepare("SELECT name, enabled FROM workflow_packs WHERE key = ?").get("development")).toEqual({
        name: "Development Updated",
        enabled: 0,
      });
      expect(harness.db.prepare("SELECT name FROM workflow_packs WHERE key = ?").get("report")).toEqual({
        name: "Structured Report",
      });
    } finally {
      harness.db.close();
    }
  });

  it("unknown key import는 rollback 한다", () => {
    const harness = createHarness();
    try {
      const handler = harness.postRoutes.get("/api/workflow-packs/import");
      const res = createFakeResponse();
      handler?.(
        {
          body: {
            version: 1,
            exported_at: 1700000000000,
            packs: [
              {
                key: "unknown",
                name: "Invalid",
                enabled: true,
                input_schema: {},
                prompt_preset: {},
                qa_rules: {},
                output_template: {},
                routing_keywords: [],
                cost_profile: {},
              },
            ],
          },
        },
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({
        error: "unknown_pack_key",
        field: "key",
        key: "unknown",
      });
      expect(
        harness.db.prepare("SELECT name FROM workflow_packs WHERE key = ?").get("development"),
      ).toEqual({ name: "Development" });
    } finally {
      harness.db.close();
    }
  });

  it("duplicate key import는 rollback 한다", () => {
    const harness = createHarness();
    try {
      const handler = harness.postRoutes.get("/api/workflow-packs/import");
      const res = createFakeResponse();
      handler?.(
        {
          body: {
            version: 1,
            exported_at: 1700000000000,
            packs: [
              {
                key: "development",
                name: "One",
                enabled: true,
                input_schema: {},
                prompt_preset: {},
                qa_rules: {},
                output_template: {},
                routing_keywords: [],
                cost_profile: {},
              },
              {
                key: "development",
                name: "Two",
                enabled: true,
                input_schema: {},
                prompt_preset: {},
                qa_rules: {},
                output_template: {},
                routing_keywords: [],
                cost_profile: {},
              },
            ],
          },
        },
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({
        error: "duplicate_pack_key",
        field: "key",
        key: "development",
      });
    } finally {
      harness.db.close();
    }
  });

  it("invalid JSON field import는 rollback 한다", () => {
    const harness = createHarness();
    try {
      const handler = harness.postRoutes.get("/api/workflow-packs/import");
      const res = createFakeResponse();
      handler?.(
        {
          body: {
            version: 1,
            exported_at: 1700000000000,
            packs: [
              {
                key: "development",
                name: "Broken",
                enabled: true,
                prompt_preset: {},
                qa_rules: {},
                output_template: {},
                routing_keywords: [],
                cost_profile: {},
              },
            ],
          },
        },
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({
        error: "invalid_json_field",
        field: "input_schema",
        key: "development",
      });
      expect(
        harness.db.prepare("SELECT name FROM workflow_packs WHERE key = ?").get("development"),
      ).toEqual({ name: "Development" });
    } finally {
      harness.db.close();
    }
  });

  it("workflow route preview는 project_path file default를 project default보다 우선한다", () => {
    const harness = createHarness();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-route-pack-"));
    try {
      fs.writeFileSync(
        path.join(projectDir, ".claw-workflow.json"),
        JSON.stringify({ defaultWorkflowPackKey: "report" }, null, 2),
        "utf8",
      );
      harness.db
        .prepare(
          `
            INSERT INTO workflow_packs (
              key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
              output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "report",
          "Structured Report",
          1,
          '{"required":["goal"]}',
          '{"mode":"reporting"}',
          '{"failOnMissingSections":true}',
          '{"sections":["summary"]}',
          '["report"]',
          '{"maxRounds":2}',
          1,
          1,
        );
      harness.db.prepare("INSERT INTO projects (id, project_path, default_pack_key) VALUES (?, ?, ?)").run(
        "project-1",
        projectDir,
        "development",
      );
      const handler = harness.postRoutes.get("/api/workflow/route");
      const res = createFakeResponse();
      handler?.({ body: { text: "plain task", project_id: "project-1" } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        packKey: "report",
        reason: "project_file_default",
        requiresConfirmation: false,
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      harness.db.close();
    }
  });

  it("effective preview는 file override가 있으면 merged pack과 warning 정보를 반환한다", () => {
    const harness = createHarness();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-effective-pack-"));
    try {
      fs.writeFileSync(
        path.join(projectDir, ".claw-workflow.json"),
        JSON.stringify(
          {
            packOverrides: {
              development: {
                prompt_preset: { mode: "project-engineering" },
                routing_keywords: ["project-only"],
                enabled: false,
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const handler = harness.getRoutes.get("/api/workflow-packs/:key/effective");
      const res = createFakeResponse();
      handler?.({ params: { key: "development" }, query: { projectPath: projectDir } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        override_applied: true,
        override_fields: ["prompt_preset", "routing_keywords"],
        source: "json_override",
        pack: {
          key: "development",
          prompt_preset: { mode: "project-engineering" },
          routing_keywords: ["project-only"],
          qa_rules: { requireTestEvidence: true },
        },
        project_policy_markdown: null,
        policy_applied: false,
        config_sources: ["claw_workflow_json"],
      });
      expect((res.payload as any).warnings).toEqual([
        ".claw-workflow.json unsupported packOverrides.development.enabled, ignoring",
      ]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      harness.db.close();
    }
  });

  it("effective preview는 WORKFLOW.md policy와 override source를 함께 반환한다", () => {
    const harness = createHarness();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-effective-workflow-md-"));
    try {
      fs.writeFileSync(
        path.join(projectDir, "WORKFLOW.md"),
        `---
packOverrides:
  development:
    prompt_preset:
      mode: workflow-engineering
---

Repository-owned workflow policy.
`,
        "utf8",
      );

      const handler = harness.getRoutes.get("/api/workflow-packs/:key/effective");
      const res = createFakeResponse();
      handler?.({ params: { key: "development" }, query: { projectPath: projectDir } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        override_applied: true,
        override_fields: ["prompt_preset"],
        source: "workflow_md_override",
        project_policy_markdown: "Repository-owned workflow policy.",
        policy_applied: true,
        config_sources: ["workflow_md"],
        pack: {
          key: "development",
          prompt_preset: { mode: "workflow-engineering" },
        },
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      harness.db.close();
    }
  });
});
