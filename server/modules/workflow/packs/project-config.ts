import fs from "node:fs";
import path from "node:path";
import { isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";

export const PROJECT_WORKFLOW_CONFIG_FILENAME = ".claw-workflow.json";

export type ProjectWorkflowConfig = {
  path: string;
  raw: Record<string, unknown> | null;
  warnings: string[];
};

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeWorkflowPackKey(value: unknown): WorkflowPackKey | null {
  const text = typeof value === "string" ? value.trim() : "";
  return isWorkflowPackKey(text) ? text : null;
}

export function readProjectWorkflowConfig(basePath: string): ProjectWorkflowConfig | null {
  if (!basePath || typeof basePath !== "string") return null;
  const configPath = path.join(basePath, PROJECT_WORKFLOW_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return null;

  let rawText = "";
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch {
    return {
      path: configPath,
      raw: null,
      warnings: [".claw-workflow.json parse failed, falling back to global"],
    };
  }

  const parsed = safeJsonParse(rawText);
  const root = asObject(parsed);
  if (!root) {
    return {
      path: configPath,
      raw: null,
      warnings: [".claw-workflow.json parse failed, falling back to global"],
    };
  }

  return {
    path: configPath,
    raw: root,
    warnings: [],
  };
}

export function readProjectWorkflowDefaultPackKey(projectPath: string): {
  packKey: WorkflowPackKey | null;
  warnings: string[];
} {
  const config = readProjectWorkflowConfig(projectPath);
  if (!config) {
    return { packKey: null, warnings: [] };
  }
  if (!config.raw) {
    return { packKey: null, warnings: [...config.warnings] };
  }

  const rawValue = config.raw.defaultWorkflowPackKey;
  const packKey = normalizeWorkflowPackKey(rawValue);
  if (packKey) {
    return { packKey, warnings: [] };
  }

  if (typeof rawValue === "string" && rawValue.trim()) {
    return {
      packKey: null,
      warnings: [".claw-workflow.json invalid defaultWorkflowPackKey, falling back to project default"],
    };
  }

  return { packKey: null, warnings: [] };
}

