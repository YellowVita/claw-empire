import type { DatabaseSync } from "node:sqlite";
import type { WorkflowPackKey } from "./definitions.ts";
import {
  readProjectWorkflowPackOverrideCached,
  type ProjectWorkflowConfigSource,
  type WorkflowPackOverrideField,
} from "./project-config.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

type WorkflowPackRow = {
  key: string;
  name: string;
  enabled: number;
  input_schema_json: string;
  prompt_preset_json: string;
  qa_rules_json: string;
  output_template_json: string;
  routing_keywords_json: string;
  cost_profile_json: string;
};

export type EffectiveWorkflowPack = {
  key: WorkflowPackKey;
  name: string;
  enabled: boolean;
  input_schema: unknown;
  prompt_preset: unknown;
  qa_rules: unknown;
  output_template: unknown;
  routing_keywords: unknown;
  cost_profile: unknown;
};

export type EffectiveWorkflowPackResult = {
  pack: EffectiveWorkflowPack | null;
  override_applied: boolean;
  override_fields: WorkflowPackOverrideField[];
  source: "db" | "json_override" | "workflow_md_override" | "merged_file_override";
  project_policy_markdown: string | null;
  policy_applied: boolean;
  config_sources: ProjectWorkflowConfigSource[];
  last_known_good_applied: boolean;
  last_known_good_cached_at: number | null;
  warnings: string[];
};

function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function loadWorkflowPackRow(db: DbLike, packKey: WorkflowPackKey): WorkflowPackRow | null {
  try {
    const row = db.prepare("SELECT * FROM workflow_packs WHERE key = ? LIMIT 1").get(packKey) as WorkflowPackRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function toEffectiveWorkflowPack(row: WorkflowPackRow): EffectiveWorkflowPack {
  return {
    key: row.key as WorkflowPackKey,
    name: row.name,
    enabled: row.enabled !== 0,
    input_schema: parseStoredJson(row.input_schema_json),
    prompt_preset: parseStoredJson(row.prompt_preset_json),
    qa_rules: parseStoredJson(row.qa_rules_json),
    output_template: parseStoredJson(row.output_template_json),
    routing_keywords: parseStoredJson(row.routing_keywords_json),
    cost_profile: parseStoredJson(row.cost_profile_json),
  };
}

export function buildEffectiveWorkflowPack(params: {
  db: DbLike;
  packKey: WorkflowPackKey;
  projectPath?: string | null;
}): EffectiveWorkflowPackResult {
  const { db, packKey, projectPath } = params;
  const row = loadWorkflowPackRow(db, packKey);
  if (!row) {
    return {
      pack: null,
      override_applied: false,
      override_fields: [],
      source: "db",
      project_policy_markdown: null,
      policy_applied: false,
      config_sources: [],
      last_known_good_applied: false,
      last_known_good_cached_at: null,
      warnings: [`workflow pack '${packKey}' not found in DB`],
    };
  }

  const basePack = toEffectiveWorkflowPack(row);
  const normalizedProjectPath = typeof projectPath === "string" ? projectPath.trim() : "";
  if (!normalizedProjectPath) {
    return {
      pack: basePack,
      override_applied: false,
      override_fields: [],
      source: "db",
      project_policy_markdown: null,
      policy_applied: false,
      config_sources: [],
      last_known_good_applied: false,
      last_known_good_cached_at: null,
      warnings: [],
    };
  }

  const fileOverride = readProjectWorkflowPackOverrideCached(db, normalizedProjectPath, packKey);
  const projectPolicyMarkdown = fileOverride.policyMarkdown;
  const configSources = fileOverride.configSources;
  const policyApplied = packKey === "development" && typeof projectPolicyMarkdown === "string" && projectPolicyMarkdown.trim().length > 0;
  if (fileOverride.overrideFields.length <= 0) {
    return {
      pack: basePack,
      override_applied: false,
      override_fields: [],
      source: "db",
      project_policy_markdown: projectPolicyMarkdown,
      policy_applied: policyApplied,
      config_sources: configSources,
      last_known_good_applied: fileOverride.cacheApplied,
      last_known_good_cached_at: fileOverride.cacheUpdatedAt,
      warnings: fileOverride.warnings,
    };
  }

  const mergedPack: EffectiveWorkflowPack = { ...basePack };
  for (const field of fileOverride.overrideFields) {
    mergedPack[field] = fileOverride.override[field];
  }

  return {
    pack: mergedPack,
    override_applied: true,
    override_fields: fileOverride.overrideFields,
    source:
      configSources.length > 1
        ? "merged_file_override"
        : configSources[0] === "workflow_md"
          ? "workflow_md_override"
          : "json_override",
    project_policy_markdown: projectPolicyMarkdown,
    policy_applied: policyApplied,
    config_sources: configSources,
    last_known_good_applied: fileOverride.cacheApplied,
    last_known_good_cached_at: fileOverride.cacheUpdatedAt,
    warnings: fileOverride.warnings,
  };
}
