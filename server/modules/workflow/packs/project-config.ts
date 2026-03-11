import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";

export const PROJECT_WORKFLOW_CONFIG_FILENAME = ".claw-workflow.json";
export const PROJECT_WORKFLOW_CONTRACT_FILENAME = "WORKFLOW.md";
export const WORKFLOW_PACK_OVERRIDE_FIELDS = [
  "prompt_preset",
  "qa_rules",
  "output_template",
  "routing_keywords",
  "cost_profile",
] as const;
export type WorkflowPackOverrideField = (typeof WORKFLOW_PACK_OVERRIDE_FIELDS)[number];
export type ProjectWorkflowPackOverride = Partial<Record<WorkflowPackOverrideField, unknown>>;
export type ProjectWorkflowConfigSource = "workflow_md" | "claw_workflow_json";

export type ProjectWorkflowConfig = {
  path: string;
  raw: Record<string, unknown> | null;
  policyMarkdown: string | null;
  sources: ProjectWorkflowConfigSource[];
  warnings: string[];
};

type ParsedProjectWorkflowSource = {
  path: string;
  raw: Record<string, unknown> | null;
  policyMarkdown: string | null;
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

function splitWorkflowContract(content: string): { frontMatter: string; body: string } | null {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { frontMatter: "", body: content };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex < 0) return null;

  return {
    frontMatter: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

function mergePackOverrides(
  baseValue: Record<string, unknown> | null,
  overrideValue: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(baseValue ?? {}) };
  for (const [packKey, value] of Object.entries(overrideValue)) {
    const basePackValue = asObject(merged[packKey]);
    const overridePackValue = asObject(value);
    merged[packKey] = basePackValue && overridePackValue ? { ...basePackValue, ...overridePackValue } : value;
  }
  return merged;
}

function mergeProjectWorkflowRaw(
  baseValue: Record<string, unknown> | null,
  overrideValue: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!baseValue && !overrideValue) return null;
  if (!baseValue) return overrideValue ? { ...overrideValue } : null;
  if (!overrideValue) return { ...baseValue };

  const merged: Record<string, unknown> = { ...baseValue };
  for (const [key, value] of Object.entries(overrideValue)) {
    if (key === "packOverrides") {
      const baseOverrides = asObject(merged[key]);
      const overrideOverrides = asObject(value);
      merged[key] =
        overrideOverrides && baseOverrides
          ? mergePackOverrides(baseOverrides, overrideOverrides)
          : overrideOverrides ?? value;
      continue;
    }
    if (key === "taskExecutionHooks") {
      const baseHooks = asObject(merged[key]);
      const overrideHooks = asObject(value);
      merged[key] = overrideHooks && baseHooks ? { ...baseHooks, ...overrideHooks } : overrideHooks ?? value;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function readJsonWorkflowSource(basePath: string): ParsedProjectWorkflowSource | null {
  const configPath = path.join(basePath, PROJECT_WORKFLOW_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return null;

  let rawText = "";
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch {
    return {
      path: configPath,
      raw: null,
      policyMarkdown: null,
      warnings: [".claw-workflow.json parse failed, falling back to global"],
    };
  }

  const parsed = safeJsonParse(rawText);
  const root = asObject(parsed);
  if (!root) {
    return {
      path: configPath,
      raw: null,
      policyMarkdown: null,
      warnings: [".claw-workflow.json parse failed, falling back to global"],
    };
  }

  return {
    path: configPath,
    raw: root,
    policyMarkdown: null,
    warnings: [],
  };
}

function readWorkflowMarkdownSource(basePath: string): ParsedProjectWorkflowSource | null {
  const contractPath = path.join(basePath, PROJECT_WORKFLOW_CONTRACT_FILENAME);
  if (!fs.existsSync(contractPath)) return null;

  let rawText = "";
  try {
    rawText = fs.readFileSync(contractPath, "utf8");
  } catch {
    return {
      path: contractPath,
      raw: null,
      policyMarkdown: null,
      warnings: ["WORKFLOW.md parse failed, falling back to .claw-workflow.json/global"],
    };
  }

  const split = splitWorkflowContract(rawText);
  if (!split) {
    return {
      path: contractPath,
      raw: null,
      policyMarkdown: null,
      warnings: ["WORKFLOW.md parse failed, falling back to .claw-workflow.json/global"],
    };
  }

  let frontMatter: Record<string, unknown> = {};
  if (split.frontMatter.trim()) {
    try {
      const parsed = parseYaml(split.frontMatter);
      const root = asObject(parsed);
      if (!root) {
        return {
          path: contractPath,
          raw: null,
          policyMarkdown: null,
          warnings: ["WORKFLOW.md parse failed, falling back to .claw-workflow.json/global"],
        };
      }
      frontMatter = root;
    } catch {
      return {
        path: contractPath,
        raw: null,
        policyMarkdown: null,
        warnings: ["WORKFLOW.md parse failed, falling back to .claw-workflow.json/global"],
      };
    }
  }

  const policyMarkdown = split.body.trim() || null;
  return {
    path: contractPath,
    raw: frontMatter,
    policyMarkdown,
    warnings: [],
  };
}

export function describeProjectWorkflowConfigSource(config: Pick<ProjectWorkflowConfig, "sources">): string {
  if (config.sources.length > 1) return "project workflow config";
  if (config.sources[0] === "workflow_md") return "WORKFLOW.md";
  if (config.sources[0] === "claw_workflow_json") return ".claw-workflow.json";
  return "project workflow config";
}

export function readProjectWorkflowConfig(basePath: string): ProjectWorkflowConfig | null {
  if (!basePath || typeof basePath !== "string") return null;

  const markdownSource = readWorkflowMarkdownSource(basePath);
  const jsonSource = readJsonWorkflowSource(basePath);
  if (!markdownSource && !jsonSource) return null;

  const mergedRaw = mergeProjectWorkflowRaw(jsonSource?.raw ?? null, markdownSource?.raw ?? null);
  const sources: ProjectWorkflowConfigSource[] = [];
  if (markdownSource?.raw) sources.push("workflow_md");
  if (jsonSource?.raw) sources.push("claw_workflow_json");

  return {
    path: markdownSource?.path ?? jsonSource?.path ?? path.join(basePath, PROJECT_WORKFLOW_CONTRACT_FILENAME),
    raw: mergedRaw,
    policyMarkdown: markdownSource?.raw ? markdownSource.policyMarkdown : null,
    sources,
    warnings: [...(markdownSource?.warnings ?? []), ...(jsonSource?.warnings ?? [])],
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
    return { packKey, warnings: [...config.warnings] };
  }

  if (typeof rawValue === "string" && rawValue.trim()) {
    return {
      packKey: null,
      warnings: [
        ...config.warnings,
        `${describeProjectWorkflowConfigSource(config)} invalid defaultWorkflowPackKey, falling back to project default`,
      ],
    };
  }

  return { packKey: null, warnings: [...config.warnings] };
}

export function readProjectWorkflowPackOverride(
  projectPath: string,
  packKey: WorkflowPackKey,
): {
  override: ProjectWorkflowPackOverride;
  overrideFields: WorkflowPackOverrideField[];
  warnings: string[];
  policyMarkdown: string | null;
  configSources: ProjectWorkflowConfigSource[];
} {
  const config = readProjectWorkflowConfig(projectPath);
  if (!config) {
    return { override: {}, overrideFields: [], warnings: [], policyMarkdown: null, configSources: [] };
  }
  if (!config.raw) {
    return {
      override: {},
      overrideFields: [],
      warnings: [...config.warnings],
      policyMarkdown: config.policyMarkdown,
      configSources: [...config.sources],
    };
  }

  const warnings = [...config.warnings];
  const sourceLabel = describeProjectWorkflowConfigSource(config);
  const rawOverrides = config.raw.packOverrides;
  if (rawOverrides === undefined) {
    return {
      override: {},
      overrideFields: [],
      warnings,
      policyMarkdown: config.policyMarkdown,
      configSources: [...config.sources],
    };
  }
  if (!isPlainObject(rawOverrides)) {
    warnings.push(`${sourceLabel} invalid packOverrides object, falling back to DB pack`);
    return {
      override: {},
      overrideFields: [],
      warnings,
      policyMarkdown: config.policyMarkdown,
      configSources: [...config.sources],
    };
  }

  for (const overridePackKey of Object.keys(rawOverrides)) {
    if (!isWorkflowPackKey(overridePackKey)) {
      warnings.push(`${sourceLabel} unknown packOverrides key '${overridePackKey}', ignoring`);
    }
  }

  const rawPackOverride = rawOverrides[packKey];
  if (rawPackOverride === undefined) {
    return {
      override: {},
      overrideFields: [],
      warnings,
      policyMarkdown: config.policyMarkdown,
      configSources: [...config.sources],
    };
  }
  if (!isPlainObject(rawPackOverride)) {
    warnings.push(`${sourceLabel} invalid packOverrides.${packKey} object, falling back to DB pack`);
    return {
      override: {},
      overrideFields: [],
      warnings,
      policyMarkdown: config.policyMarkdown,
      configSources: [...config.sources],
    };
  }

  const override: ProjectWorkflowPackOverride = {};
  const overrideFields: WorkflowPackOverrideField[] = [];
  for (const [field, value] of Object.entries(rawPackOverride)) {
    if (!isValidOverrideField(field)) {
      warnings.push(`${sourceLabel} unsupported packOverrides.${packKey}.${field}, ignoring`);
      continue;
    }
    if (!validateWorkflowPackOverrideField(field, value)) {
      warnings.push(`${sourceLabel} invalid packOverrides.${packKey}.${field}, keeping DB value`);
      continue;
    }
    override[field] = value;
    overrideFields.push(field);
  }

  return {
    override,
    overrideFields,
    warnings,
    policyMarkdown: config.policyMarkdown,
    configSources: [...config.sources],
  };
}
