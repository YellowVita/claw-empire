import fs from "node:fs";
import path from "node:path";
import { isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";

export const PROJECT_WORKFLOW_CONFIG_FILENAME = ".claw-workflow.json";
export const WORKFLOW_PACK_OVERRIDE_FIELDS = [
  "prompt_preset",
  "qa_rules",
  "output_template",
  "routing_keywords",
  "cost_profile",
] as const;
export type WorkflowPackOverrideField = (typeof WORKFLOW_PACK_OVERRIDE_FIELDS)[number];
export type ProjectWorkflowPackOverride = Partial<Record<WorkflowPackOverrideField, unknown>>;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidOverrideField(field: string): field is WorkflowPackOverrideField {
  return (WORKFLOW_PACK_OVERRIDE_FIELDS as readonly string[]).includes(field);
}

function validateWorkflowPackOverrideField(field: WorkflowPackOverrideField, value: unknown): boolean {
  if (field === "routing_keywords") {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
  return isPlainObject(value);
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

export function readProjectWorkflowPackOverride(
  projectPath: string,
  packKey: WorkflowPackKey,
): {
  override: ProjectWorkflowPackOverride;
  overrideFields: WorkflowPackOverrideField[];
  warnings: string[];
} {
  const config = readProjectWorkflowConfig(projectPath);
  if (!config) {
    return { override: {}, overrideFields: [], warnings: [] };
  }
  if (!config.raw) {
    return { override: {}, overrideFields: [], warnings: [...config.warnings] };
  }

  const warnings = [...config.warnings];
  const rawOverrides = config.raw.packOverrides;
  if (rawOverrides === undefined) {
    return { override: {}, overrideFields: [], warnings };
  }
  if (!isPlainObject(rawOverrides)) {
    warnings.push(".claw-workflow.json invalid packOverrides object, falling back to DB pack");
    return { override: {}, overrideFields: [], warnings };
  }

  for (const overridePackKey of Object.keys(rawOverrides)) {
    if (!isWorkflowPackKey(overridePackKey)) {
      warnings.push(`.claw-workflow.json unknown packOverrides key '${overridePackKey}', ignoring`);
    }
  }

  const rawPackOverride = rawOverrides[packKey];
  if (rawPackOverride === undefined) {
    return { override: {}, overrideFields: [], warnings };
  }
  if (!isPlainObject(rawPackOverride)) {
    warnings.push(`.claw-workflow.json invalid packOverrides.${packKey} object, falling back to DB pack`);
    return { override: {}, overrideFields: [], warnings };
  }

  const override: ProjectWorkflowPackOverride = {};
  const overrideFields: WorkflowPackOverrideField[] = [];
  for (const [field, value] of Object.entries(rawPackOverride)) {
    if (!isValidOverrideField(field)) {
      warnings.push(`.claw-workflow.json unsupported packOverrides.${packKey}.${field}, ignoring`);
      continue;
    }
    if (!validateWorkflowPackOverrideField(field, value)) {
      warnings.push(`.claw-workflow.json invalid packOverrides.${packKey}.${field}, keeping DB value`);
      continue;
    }
    override[field] = value;
    overrideFields.push(field);
  }

  return { override, overrideFields, warnings };
}
