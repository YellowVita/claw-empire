import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectWorkflowPackOverride } from "./project-config.ts";

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

describe("project workflow pack overrides", () => {
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
});
