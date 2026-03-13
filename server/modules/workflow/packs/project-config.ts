import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parse as parseYaml } from "yaml";
import { isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";

export const PROJECT_WORKFLOW_CONFIG_FILENAME = ".claw-workflow.json";
export const PROJECT_WORKFLOW_CONTRACT_FILENAME = "WORKFLOW.md";
export const PROJECT_WORKFLOW_LAST_KNOWN_GOOD_SETTING_PREFIX = "project_workflow_last_known_good::";
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
export type ProjectDevelopmentPrFeedbackGatePolicy = {
  ignoredCheckNames: string[];
  ignoredCheckPrefixes: string[];
};
export type ProjectGitBootstrapPolicy = {
  allowAutoGitBootstrap: boolean;
};
export type ProjectMergeStrategyMode = "shared_dev_pr" | "task_branch_pr";
export type ProjectMergeStrategyPolicy = {
  mode: ProjectMergeStrategyMode;
};

export type ProjectWorkflowConfig = {
  path: string;
  raw: Record<string, unknown> | null;
  policyMarkdown: string | null;
  sources: ProjectWorkflowConfigSource[];
  warnings: string[];
  cacheApplied: boolean;
  cacheUpdatedAt: number | null;
};

type ParsedProjectWorkflowSource = {
  path: string;
  raw: Record<string, unknown> | null;
  policyMarkdown: string | null;
  warnings: string[];
};

type DbLike = Pick<DatabaseSync, "prepare">;

type ProjectWorkflowCachePayload = {
  raw: Record<string, unknown> | null;
  policyMarkdown: string | null;
  sources: ProjectWorkflowConfigSource[];
  cachedAt: number;
  projectPath: string;
};

type FileWorkflowConfigReadResult = {
  config: ProjectWorkflowConfig | null;
  hasAnySource: boolean;
  hadReadFailure: boolean;
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
    if (key === "developmentPrFeedbackGate") {
      const basePolicy = asObject(merged[key]);
      const overridePolicy = asObject(value);
      merged[key] = overridePolicy && basePolicy ? { ...basePolicy, ...overridePolicy } : overridePolicy ?? value;
      continue;
    }
    if (key === "gitBootstrap") {
      const basePolicy = asObject(merged[key]);
      const overridePolicy = asObject(value);
      merged[key] = overridePolicy && basePolicy ? { ...basePolicy, ...overridePolicy } : overridePolicy ?? value;
      continue;
    }
    if (key === "mergeStrategy") {
      const basePolicy = asObject(merged[key]);
      const overridePolicy = asObject(value);
      merged[key] = overridePolicy && basePolicy ? { ...basePolicy, ...overridePolicy } : overridePolicy ?? value;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry));
  if (!isPlainObject(value)) return value;
  return Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortJsonValue(value[key]);
      return acc;
    }, {});
}

function buildProjectWorkflowCacheKey(projectPath: string): string {
  return `${PROJECT_WORKFLOW_LAST_KNOWN_GOOD_SETTING_PREFIX}${projectPath}`;
}

function parseProjectWorkflowCachePayload(value: unknown): ProjectWorkflowCachePayload | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!isPlainObject(parsed)) return null;
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter((entry): entry is ProjectWorkflowConfigSource => entry === "workflow_md" || entry === "claw_workflow_json")
      : [];
    return {
      raw: parsed.raw === null ? null : asObject(parsed.raw),
      policyMarkdown: typeof parsed.policyMarkdown === "string" && parsed.policyMarkdown.trim() ? parsed.policyMarkdown.trim() : null,
      sources,
      cachedAt: Number(parsed.cachedAt ?? 0) || 0,
      projectPath: typeof parsed.projectPath === "string" ? parsed.projectPath : "",
    };
  } catch {
    return null;
  }
}

function serializeProjectWorkflowCachePayload(payload: ProjectWorkflowCachePayload): string {
  return JSON.stringify(
    sortJsonValue({
      raw: payload.raw,
      policyMarkdown: payload.policyMarkdown,
      sources: payload.sources,
      cachedAt: payload.cachedAt,
      projectPath: payload.projectPath,
    }),
  );
}

function serializeProjectWorkflowCacheComparablePayload(
  payload: Pick<ProjectWorkflowCachePayload, "raw" | "policyMarkdown" | "sources" | "projectPath">,
): string {
  return JSON.stringify(
    sortJsonValue({
      raw: payload.raw,
      policyMarkdown: payload.policyMarkdown,
      sources: payload.sources,
      projectPath: payload.projectPath,
    }),
  );
}

function readProjectWorkflowCachePayload(db: DbLike, projectPath: string): ProjectWorkflowCachePayload | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(buildProjectWorkflowCacheKey(projectPath)) as
      | { value?: unknown }
      | undefined;
    return parseProjectWorkflowCachePayload(row?.value);
  } catch {
    return null;
  }
}

function writeProjectWorkflowCachePayload(db: DbLike, payload: ProjectWorkflowCachePayload): void {
  try {
    const key = buildProjectWorkflowCacheKey(payload.projectPath);
    const nextValue = serializeProjectWorkflowCachePayload(payload);
    const existing = readProjectWorkflowCachePayload(db, payload.projectPath);
    if (
      existing &&
      serializeProjectWorkflowCacheComparablePayload(existing) === serializeProjectWorkflowCacheComparablePayload(payload)
    ) {
      return;
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      key,
      nextValue,
    );
  } catch {
    // best effort cache write
  }
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

function readProjectWorkflowConfigFromFiles(basePath: string): FileWorkflowConfigReadResult {
  if (!basePath || typeof basePath !== "string") {
    return { config: null, hasAnySource: false, hadReadFailure: false };
  }

  const markdownSource = readWorkflowMarkdownSource(basePath);
  const jsonSource = readJsonWorkflowSource(basePath);
  if (!markdownSource && !jsonSource) {
    return { config: null, hasAnySource: false, hadReadFailure: false };
  }

  const mergedRaw = mergeProjectWorkflowRaw(jsonSource?.raw ?? null, markdownSource?.raw ?? null);
  const sources: ProjectWorkflowConfigSource[] = [];
  if (markdownSource?.raw) sources.push("workflow_md");
  if (jsonSource?.raw) sources.push("claw_workflow_json");
  const hadReadFailure = Boolean(
    (markdownSource && markdownSource.raw === null && markdownSource.warnings.length > 0) ||
      (jsonSource && jsonSource.raw === null && jsonSource.warnings.length > 0),
  );

  return {
    config: {
      path: markdownSource?.path ?? jsonSource?.path ?? path.join(basePath, PROJECT_WORKFLOW_CONTRACT_FILENAME),
      raw: mergedRaw,
      policyMarkdown: markdownSource?.raw ? markdownSource.policyMarkdown : null,
      sources,
      warnings: [...(markdownSource?.warnings ?? []), ...(jsonSource?.warnings ?? [])],
      cacheApplied: false,
      cacheUpdatedAt: null,
    },
    hasAnySource: true,
    hadReadFailure,
  };
}

export function readProjectWorkflowConfig(basePath: string): ProjectWorkflowConfig | null {
  const result = readProjectWorkflowConfigFromFiles(basePath);
  return result?.config ?? null;
}

export function readProjectWorkflowConfigCached(
  db: DbLike,
  basePath: string,
  options?: { nowMs?: () => number },
): ProjectWorkflowConfig | null {
  const normalizedPath = typeof basePath === "string" ? basePath.trim() : "";
  if (!normalizedPath) return null;

  const fileResult = readProjectWorkflowConfigFromFiles(normalizedPath);
  if (!fileResult.hasAnySource) return null;

  const fileConfig = fileResult.config;
  if (!fileConfig) return null;

  if (fileResult.hadReadFailure) {
    const cached = readProjectWorkflowCachePayload(db, normalizedPath);
    if (cached) {
      return {
        path: fileConfig.path,
        raw: cached.raw,
        policyMarkdown: cached.policyMarkdown,
        sources: cached.sources,
        warnings: [...fileConfig.warnings, "last-known-good applied from settings cache"],
        cacheApplied: true,
        cacheUpdatedAt: cached.cachedAt || null,
      };
    }
    return fileConfig;
  }

  writeProjectWorkflowCachePayload(db, {
    raw: fileConfig.raw,
    policyMarkdown: fileConfig.policyMarkdown,
    sources: fileConfig.sources,
    cachedAt: options?.nowMs ? options.nowMs() : Date.now(),
    projectPath: normalizedPath,
  });
  return fileConfig;
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

export function readProjectWorkflowDefaultPackKeyCached(
  db: DbLike,
  projectPath: string,
  options?: { nowMs?: () => number },
): {
  packKey: WorkflowPackKey | null;
  warnings: string[];
  cacheApplied: boolean;
  cacheUpdatedAt: number | null;
} {
  const config = readProjectWorkflowConfigCached(db, projectPath, options);
  if (!config) {
    return { packKey: null, warnings: [], cacheApplied: false, cacheUpdatedAt: null };
  }
  if (!config.raw) {
    return {
      packKey: null,
      warnings: [...config.warnings],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
    };
  }
  const rawValue = config.raw.defaultWorkflowPackKey;
  const packKey = normalizeWorkflowPackKey(rawValue);
  if (packKey) {
    return {
      packKey,
      warnings: [...config.warnings],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
    };
  }
  if (typeof rawValue === "string" && rawValue.trim()) {
    return {
      packKey: null,
      warnings: [
        ...config.warnings,
        `${describeProjectWorkflowConfigSource(config)} invalid defaultWorkflowPackKey, falling back to project default`,
      ],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
    };
  }
  return {
    packKey: null,
    warnings: [...config.warnings],
    cacheApplied: config.cacheApplied,
    cacheUpdatedAt: config.cacheUpdatedAt,
  };
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

export function readProjectWorkflowPackOverrideCached(
  db: DbLike,
  projectPath: string,
  packKey: WorkflowPackKey,
  options?: { nowMs?: () => number },
): {
  override: ProjectWorkflowPackOverride;
  overrideFields: WorkflowPackOverrideField[];
  warnings: string[];
  policyMarkdown: string | null;
  configSources: ProjectWorkflowConfigSource[];
  cacheApplied: boolean;
  cacheUpdatedAt: number | null;
} {
  const config = readProjectWorkflowConfigCached(db, projectPath, options);
  if (!config) {
    return {
      override: {},
      overrideFields: [],
      warnings: [],
      policyMarkdown: null,
      configSources: [],
      cacheApplied: false,
      cacheUpdatedAt: null,
    };
  }
  if (!config.raw) {
    return {
      override: {},
      overrideFields: [],
      warnings: [...config.warnings],
      policyMarkdown: config.policyMarkdown,
      configSources: [...config.sources],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
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
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
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
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
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
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
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
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
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
    cacheApplied: config.cacheApplied,
    cacheUpdatedAt: config.cacheUpdatedAt,
  };
}

export function readProjectDevelopmentPrFeedbackGatePolicy(projectPath: string): {
  policy: ProjectDevelopmentPrFeedbackGatePolicy;
  warnings: string[];
  configSources: ProjectWorkflowConfigSource[];
} {
  const emptyPolicy: ProjectDevelopmentPrFeedbackGatePolicy = {
    ignoredCheckNames: [],
    ignoredCheckPrefixes: [],
  };
  const config = readProjectWorkflowConfig(projectPath);
  if (!config) {
    return {
      policy: emptyPolicy,
      warnings: [],
      configSources: [],
    };
  }

  if (!config.raw) {
    return {
      policy: emptyPolicy,
      warnings: [...config.warnings],
      configSources: [...config.sources],
    };
  }

  const warnings = [...config.warnings];
  const sourceLabel = describeProjectWorkflowConfigSource(config);
  const rawPolicy = config.raw.developmentPrFeedbackGate;
  if (rawPolicy === undefined) {
    return {
      policy: emptyPolicy,
      warnings,
      configSources: [...config.sources],
    };
  }
  if (!isPlainObject(rawPolicy)) {
    warnings.push(`${sourceLabel} invalid developmentPrFeedbackGate object, ignoring`);
    return {
      policy: emptyPolicy,
      warnings,
      configSources: [...config.sources],
    };
  }

  const ignoredCheckNames =
    rawPolicy.ignoredCheckNames === undefined
      ? []
      : Array.isArray(rawPolicy.ignoredCheckNames)
        ? normalizeStringList(rawPolicy.ignoredCheckNames)
        : (() => {
            warnings.push(`${sourceLabel} invalid developmentPrFeedbackGate.ignoredCheckNames, ignoring`);
            return [];
          })();

  const ignoredCheckPrefixes =
    rawPolicy.ignoredCheckPrefixes === undefined
      ? []
      : Array.isArray(rawPolicy.ignoredCheckPrefixes)
        ? normalizeStringList(rawPolicy.ignoredCheckPrefixes)
        : (() => {
            warnings.push(`${sourceLabel} invalid developmentPrFeedbackGate.ignoredCheckPrefixes, ignoring`);
            return [];
          })();

  if (Array.isArray(rawPolicy.ignoredCheckNames)) {
    const invalidEntries = rawPolicy.ignoredCheckNames.some((entry) => typeof entry !== "string");
    if (invalidEntries) {
      warnings.push(`${sourceLabel} invalid developmentPrFeedbackGate.ignoredCheckNames entries, ignoring non-string values`);
    }
  }
  if (Array.isArray(rawPolicy.ignoredCheckPrefixes)) {
    const invalidEntries = rawPolicy.ignoredCheckPrefixes.some((entry) => typeof entry !== "string");
    if (invalidEntries) {
      warnings.push(
        `${sourceLabel} invalid developmentPrFeedbackGate.ignoredCheckPrefixes entries, ignoring non-string values`,
      );
    }
  }

  return {
    policy: {
      ignoredCheckNames,
      ignoredCheckPrefixes,
    },
    warnings,
    configSources: [...config.sources],
  };
}

export function readProjectDevelopmentPrFeedbackGatePolicyCached(
  db: DbLike,
  projectPath: string,
  options?: { nowMs?: () => number },
): {
  policy: ProjectDevelopmentPrFeedbackGatePolicy;
  warnings: string[];
  configSources: ProjectWorkflowConfigSource[];
  cacheApplied: boolean;
  cacheUpdatedAt: number | null;
} {
  const emptyPolicy: ProjectDevelopmentPrFeedbackGatePolicy = {
    ignoredCheckNames: [],
    ignoredCheckPrefixes: [],
  };
  const config = readProjectWorkflowConfigCached(db, projectPath, options);
  if (!config) {
    return {
      policy: emptyPolicy,
      warnings: [],
      configSources: [],
      cacheApplied: false,
      cacheUpdatedAt: null,
    };
  }

  if (!config.raw) {
    return {
      policy: emptyPolicy,
      warnings: [...config.warnings],
      configSources: [...config.sources],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
    };
  }

  const warnings = [...config.warnings];
  const sourceLabel = describeProjectWorkflowConfigSource(config);
  const rawPolicy = config.raw.developmentPrFeedbackGate;
  if (rawPolicy === undefined) {
    return {
      policy: emptyPolicy,
      warnings,
      configSources: [...config.sources],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
    };
  }
  if (!isPlainObject(rawPolicy)) {
    warnings.push(`${sourceLabel} invalid developmentPrFeedbackGate object, ignoring`);
    return {
      policy: emptyPolicy,
      warnings,
      configSources: [...config.sources],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
    };
  }

  const ignoredCheckNames =
    rawPolicy.ignoredCheckNames === undefined
      ? []
      : Array.isArray(rawPolicy.ignoredCheckNames)
        ? normalizeStringList(rawPolicy.ignoredCheckNames)
        : (() => {
            warnings.push(`${sourceLabel} invalid developmentPrFeedbackGate.ignoredCheckNames, ignoring`);
            return [];
          })();

  const ignoredCheckPrefixes =
    rawPolicy.ignoredCheckPrefixes === undefined
      ? []
      : Array.isArray(rawPolicy.ignoredCheckPrefixes)
        ? normalizeStringList(rawPolicy.ignoredCheckPrefixes)
        : (() => {
            warnings.push(`${sourceLabel} invalid developmentPrFeedbackGate.ignoredCheckPrefixes, ignoring`);
            return [];
          })();

  if (Array.isArray(rawPolicy.ignoredCheckNames)) {
    const invalidEntries = rawPolicy.ignoredCheckNames.some((entry) => typeof entry !== "string");
    if (invalidEntries) {
      warnings.push(`${sourceLabel} invalid developmentPrFeedbackGate.ignoredCheckNames entries, ignoring non-string values`);
    }
  }
  if (Array.isArray(rawPolicy.ignoredCheckPrefixes)) {
    const invalidEntries = rawPolicy.ignoredCheckPrefixes.some((entry) => typeof entry !== "string");
    if (invalidEntries) {
      warnings.push(
        `${sourceLabel} invalid developmentPrFeedbackGate.ignoredCheckPrefixes entries, ignoring non-string values`,
      );
    }
  }

  return {
    policy: {
      ignoredCheckNames,
      ignoredCheckPrefixes,
    },
    warnings,
    configSources: [...config.sources],
    cacheApplied: config.cacheApplied,
    cacheUpdatedAt: config.cacheUpdatedAt,
  };
}

export function readProjectGitBootstrapPolicy(projectPath: string): {
  policy: ProjectGitBootstrapPolicy;
  warnings: string[];
  configSources: ProjectWorkflowConfigSource[];
  valid: boolean;
} {
  const defaultPolicy: ProjectGitBootstrapPolicy = {
    allowAutoGitBootstrap: false,
  };
  const config = readProjectWorkflowConfig(projectPath);
  if (!config) {
    return {
      policy: defaultPolicy,
      warnings: [],
      configSources: [],
      valid: true,
    };
  }

  if (!config.raw) {
    return {
      policy: defaultPolicy,
      warnings: [...config.warnings],
      configSources: [...config.sources],
      valid: false,
    };
  }

  const warnings = [...config.warnings];
  const sourceLabel = describeProjectWorkflowConfigSource(config);
  const rawPolicy = config.raw.gitBootstrap;
  if (rawPolicy === undefined) {
    return {
      policy: defaultPolicy,
      warnings,
      configSources: [...config.sources],
      valid: true,
    };
  }
  if (!isPlainObject(rawPolicy)) {
    warnings.push(`${sourceLabel} invalid gitBootstrap object, ignoring`);
    return {
      policy: defaultPolicy,
      warnings,
      configSources: [...config.sources],
      valid: false,
    };
  }

  let valid = true;
  const allowAutoGitBootstrap =
    rawPolicy.allowAutoGitBootstrap === undefined
      ? false
      : typeof rawPolicy.allowAutoGitBootstrap === "boolean"
        ? rawPolicy.allowAutoGitBootstrap
        : (() => {
            valid = false;
            warnings.push(`${sourceLabel} invalid gitBootstrap.allowAutoGitBootstrap, ignoring`);
            return false;
          })();

  return {
    policy: {
      allowAutoGitBootstrap,
    },
    warnings,
    configSources: [...config.sources],
    valid,
  };
}

export function readProjectMergeStrategyPolicy(projectPath: string): {
  policy: ProjectMergeStrategyPolicy;
  warnings: string[];
  configSources: ProjectWorkflowConfigSource[];
  valid: boolean;
} {
  const defaultPolicy: ProjectMergeStrategyPolicy = {
    mode: "shared_dev_pr",
  };
  const config = readProjectWorkflowConfig(projectPath);
  if (!config) {
    return {
      policy: defaultPolicy,
      warnings: [],
      configSources: [],
      valid: true,
    };
  }
  if (!config.raw) {
    return {
      policy: defaultPolicy,
      warnings: [...config.warnings],
      configSources: [...config.sources],
      valid: false,
    };
  }

  const warnings = [...config.warnings];
  const sourceLabel = describeProjectWorkflowConfigSource(config);
  const rawPolicy = config.raw.mergeStrategy;
  if (rawPolicy === undefined) {
    return {
      policy: defaultPolicy,
      warnings,
      configSources: [...config.sources],
      valid: true,
    };
  }
  if (!isPlainObject(rawPolicy)) {
    warnings.push(`${sourceLabel} invalid mergeStrategy object, ignoring`);
    return {
      policy: defaultPolicy,
      warnings,
      configSources: [...config.sources],
      valid: false,
    };
  }

  let valid = true;
  const mode =
    rawPolicy.mode === undefined
      ? "shared_dev_pr"
      : rawPolicy.mode === "shared_dev_pr" || rawPolicy.mode === "task_branch_pr"
        ? rawPolicy.mode
        : (() => {
            valid = false;
            warnings.push(`${sourceLabel} invalid mergeStrategy.mode, ignoring`);
            return "shared_dev_pr" as const;
          })();

  return {
    policy: { mode },
    warnings,
    configSources: [...config.sources],
    valid,
  };
}

export function readProjectMergeStrategyPolicyCached(
  db: DbLike,
  projectPath: string,
  options?: { nowMs?: () => number },
): {
  policy: ProjectMergeStrategyPolicy;
  warnings: string[];
  configSources: ProjectWorkflowConfigSource[];
  cacheApplied: boolean;
  cacheUpdatedAt: number | null;
  valid: boolean;
} {
  const defaultPolicy: ProjectMergeStrategyPolicy = {
    mode: "shared_dev_pr",
  };
  const config = readProjectWorkflowConfigCached(db, projectPath, options);
  if (!config) {
    return {
      policy: defaultPolicy,
      warnings: [],
      configSources: [],
      cacheApplied: false,
      cacheUpdatedAt: null,
      valid: true,
    };
  }
  if (!config.raw) {
    return {
      policy: defaultPolicy,
      warnings: [...config.warnings],
      configSources: [...config.sources],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
      valid: false,
    };
  }

  const warnings = [...config.warnings];
  const sourceLabel = describeProjectWorkflowConfigSource(config);
  const rawPolicy = config.raw.mergeStrategy;
  if (rawPolicy === undefined) {
    return {
      policy: defaultPolicy,
      warnings,
      configSources: [...config.sources],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
      valid: true,
    };
  }
  if (!isPlainObject(rawPolicy)) {
    warnings.push(`${sourceLabel} invalid mergeStrategy object, ignoring`);
    return {
      policy: defaultPolicy,
      warnings,
      configSources: [...config.sources],
      cacheApplied: config.cacheApplied,
      cacheUpdatedAt: config.cacheUpdatedAt,
      valid: false,
    };
  }

  let valid = true;
  const mode =
    rawPolicy.mode === undefined
      ? "shared_dev_pr"
      : rawPolicy.mode === "shared_dev_pr" || rawPolicy.mode === "task_branch_pr"
        ? rawPolicy.mode
        : (() => {
            valid = false;
            warnings.push(`${sourceLabel} invalid mergeStrategy.mode, ignoring`);
            return "shared_dev_pr" as const;
          })();

  return {
    policy: { mode },
    warnings,
    configSources: [...config.sources],
    cacheApplied: config.cacheApplied,
    cacheUpdatedAt: config.cacheUpdatedAt,
    valid,
  };
}
