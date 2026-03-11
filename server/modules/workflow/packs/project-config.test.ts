import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readProjectDevelopmentPrFeedbackGatePolicy,
  readProjectWorkflowConfig,
  readProjectWorkflowDefaultPackKey,
  readProjectWorkflowPackOverride,
} from "./project-config.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("project workflow config", () => {
  it("valid override fields만 읽고 unsupported key는 warning으로 무시한다", () => {
    const projectDir = createTempDir("claw-pack-config-");
    fs.writeFileSync(
      path.join(projectDir, ".claw-workflow.json"),
      JSON.stringify(
        {
          packOverrides: {
            report: {
              prompt_preset: { mode: "project-report" },
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

    const result = readProjectWorkflowPackOverride(projectDir, "report");
    expect(result.overrideFields).toEqual(["prompt_preset", "routing_keywords"]);
    expect(result.override).toMatchObject({
      prompt_preset: { mode: "project-report" },
      routing_keywords: ["project-only"],
    });
    expect(result.warnings).toEqual([
      ".claw-workflow.json unsupported packOverrides.report.enabled, ignoring",
    ]);
    expect(result.policyMarkdown).toBeNull();
    expect(result.configSources).toEqual(["claw_workflow_json"]);
  });

  it("invalid field는 해당 필드만 fallback 한다", () => {
    const projectDir = createTempDir("claw-pack-config-invalid-");
    fs.writeFileSync(
      path.join(projectDir, ".claw-workflow.json"),
      JSON.stringify(
        {
          packOverrides: {
            development: {
              qa_rules: ["bad"],
              output_template: { sections: ["summary"] },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = readProjectWorkflowPackOverride(projectDir, "development");
    expect(result.overrideFields).toEqual(["output_template"]);
    expect(result.override).toMatchObject({
      output_template: { sections: ["summary"] },
    });
    expect(result.warnings).toEqual([
      ".claw-workflow.json invalid packOverrides.development.qa_rules, keeping DB value",
    ]);
  });

  it("WORKFLOW.md front matter와 body를 읽어 policyMarkdown과 source를 반환한다", () => {
    const projectDir = createTempDir("claw-workflow-md-");
    fs.writeFileSync(
      path.join(projectDir, "WORKFLOW.md"),
      `---
defaultWorkflowPackKey: report
packOverrides:
  report:
    prompt_preset:
      mode: workflow-report
---

# Repo policy

- Run the required validation commands before handoff.
`,
      "utf8",
    );

    const result = readProjectWorkflowConfig(projectDir);
    expect(result).toMatchObject({
      raw: {
        defaultWorkflowPackKey: "report",
        packOverrides: {
          report: {
            prompt_preset: {
              mode: "workflow-report",
            },
          },
        },
      },
      policyMarkdown: "# Repo policy\n\n- Run the required validation commands before handoff.",
      sources: ["workflow_md"],
      warnings: [],
    });
  });

  it("WORKFLOW.md가 .claw-workflow.json보다 우선하고 body는 policyMarkdown으로 유지한다", () => {
    const projectDir = createTempDir("claw-workflow-merge-");
    fs.writeFileSync(
      path.join(projectDir, ".claw-workflow.json"),
      JSON.stringify(
        {
          defaultWorkflowPackKey: "novel",
          packOverrides: {
            development: {
              prompt_preset: { mode: "json-mode", audience: "team" },
              qa_rules: { requireTestEvidence: true },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, "WORKFLOW.md"),
      `---
defaultWorkflowPackKey: report
packOverrides:
  development:
    prompt_preset:
      mode: workflow-mode
    routing_keywords:
      - workflow-only
---

Prefer repository-owned workflow policy over ad-hoc notes.
`,
      "utf8",
    );

    const defaultPack = readProjectWorkflowDefaultPackKey(projectDir);
    expect(defaultPack).toEqual({
      packKey: "report",
      warnings: [],
    });

    const override = readProjectWorkflowPackOverride(projectDir, "development");
    expect(override.override).toEqual({
      prompt_preset: { mode: "workflow-mode" },
      qa_rules: { requireTestEvidence: true },
      routing_keywords: ["workflow-only"],
    });
    expect(override.overrideFields).toEqual(["prompt_preset", "qa_rules", "routing_keywords"]);
    expect(override.policyMarkdown).toBe("Prefer repository-owned workflow policy over ad-hoc notes.");
    expect(override.configSources).toEqual(["workflow_md", "claw_workflow_json"]);
  });

  it("invalid WORKFLOW.md는 warning 후 JSON fallback 한다", () => {
    const projectDir = createTempDir("claw-workflow-invalid-md-");
    fs.writeFileSync(
      path.join(projectDir, ".claw-workflow.json"),
      JSON.stringify({ defaultWorkflowPackKey: "report" }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, "WORKFLOW.md"),
      `---
defaultWorkflowPackKey: [broken
---
`,
      "utf8",
    );

    const defaultPack = readProjectWorkflowDefaultPackKey(projectDir);
    expect(defaultPack).toEqual({
      packKey: "report",
      warnings: ["WORKFLOW.md parse failed, falling back to .claw-workflow.json/global"],
    });
  });

  it("developmentPrFeedbackGate는 WORKFLOW.md가 JSON보다 우선하고 필드 단위로 shallow merge 된다", () => {
    const projectDir = createTempDir("claw-workflow-pr-gate-");
    fs.writeFileSync(
      path.join(projectDir, ".claw-workflow.json"),
      JSON.stringify(
        {
          developmentPrFeedbackGate: {
            ignoredCheckNames: ["preview / deploy", "preview / deploy"],
            ignoredCheckPrefixes: ["optional /"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, "WORKFLOW.md"),
      `---
developmentPrFeedbackGate:
  ignoredCheckNames:
    - ci / flaky
---

Project policy
`,
      "utf8",
    );

    const result = readProjectDevelopmentPrFeedbackGatePolicy(projectDir);
    expect(result.policy).toEqual({
      ignoredCheckNames: ["ci / flaky"],
      ignoredCheckPrefixes: ["optional /"],
    });
    expect(result.warnings).toEqual([]);
    expect(result.configSources).toEqual(["workflow_md", "claw_workflow_json"]);
  });

  it("invalid developmentPrFeedbackGate entries는 warning 후 무시한다", () => {
    const projectDir = createTempDir("claw-workflow-pr-gate-invalid-");
    fs.writeFileSync(
      path.join(projectDir, ".claw-workflow.json"),
      JSON.stringify(
        {
          developmentPrFeedbackGate: {
            ignoredCheckNames: ["preview / deploy", 42, ""],
            ignoredCheckPrefixes: "optional /",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = readProjectDevelopmentPrFeedbackGatePolicy(projectDir);
    expect(result.policy).toEqual({
      ignoredCheckNames: ["preview / deploy"],
      ignoredCheckPrefixes: [],
    });
    expect(result.warnings).toEqual([
      ".claw-workflow.json invalid developmentPrFeedbackGate.ignoredCheckPrefixes, ignoring",
      ".claw-workflow.json invalid developmentPrFeedbackGate.ignoredCheckNames entries, ignoring non-string values",
    ]);
  });
});
