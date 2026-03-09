import type { DatabaseSync } from "node:sqlite";
import type { EffectiveWorkflowPack } from "./effective-pack.ts";

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

type WorkflowPackPromptField = "prompt_preset" | "qa_rules" | "output_template" | "cost_profile";

export type RuntimeWorkflowPackSource = "snapshot" | "db_fallback" | "none";

export type RuntimeWorkflowPackResolution = {
  pack: EffectiveWorkflowPack | null;
  source: RuntimeWorkflowPackSource;
};

const WORKFLOW_PACK_PROMPT_FIELD_LABELS: Record<WorkflowPackPromptField, string> = {
  prompt_preset: "Prompt Preset",
  qa_rules: "QA Rules",
  output_template: "Output Template",
  cost_profile: "Cost Profile",
};

const WORKFLOW_PACK_PROMPT_OMISSION_ORDER: WorkflowPackPromptField[] = [
  "cost_profile",
  "output_template",
  "qa_rules",
  "prompt_preset",
];

const DEFAULT_WORKFLOW_PACK_PROMPT_BUDGET = 2400;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseWorkflowMetaObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return asObject(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asObject(raw) ?? {};
}

function normalizeSnapshotPack(value: unknown): EffectiveWorkflowPack | null {
  const raw = asObject(value);
  if (!raw) return null;
  const key = typeof raw.key === "string" && raw.key.trim() ? raw.key.trim() : "";
  if (!key) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : key;
  return {
    key: key as EffectiveWorkflowPack["key"],
    name,
    enabled: raw.enabled !== false,
    input_schema: raw.input_schema ?? null,
    prompt_preset: raw.prompt_preset ?? null,
    qa_rules: raw.qa_rules ?? null,
    output_template: raw.output_template ?? null,
    routing_keywords: raw.routing_keywords ?? null,
    cost_profile: raw.cost_profile ?? null,
  };
}

function loadWorkflowPackRow(db: DbLike, packKey: string | null | undefined): WorkflowPackRow | null {
  const normalizedKey = typeof packKey === "string" ? packKey.trim() : "";
  if (!normalizedKey) return null;
  try {
    const row = db.prepare("SELECT * FROM workflow_packs WHERE key = ? LIMIT 1").get(normalizedKey) as
      | WorkflowPackRow
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function toEffectiveWorkflowPack(row: WorkflowPackRow): EffectiveWorkflowPack {
  return {
    key: row.key as EffectiveWorkflowPack["key"],
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

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry));
  const raw = asObject(value);
  if (!raw) return value;
  return Object.keys(raw)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortJsonValue(raw[key]);
      return acc;
    }, {});
}

function stringifyDeterministicJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  const raw = asObject(value);
  if (raw) return Object.keys(raw).length > 0;
  return true;
}

function renderWorkflowPackPromptBlock(params: {
  pack: EffectiveWorkflowPack;
  source: Exclude<RuntimeWorkflowPackSource, "none">;
  maxChars?: number;
}): string {
  const maxChars = Math.max(400, params.maxChars ?? DEFAULT_WORKFLOW_PACK_PROMPT_BUDGET);
  const candidateFields: WorkflowPackPromptField[] = [];
  for (const field of ["prompt_preset", "qa_rules", "output_template", "cost_profile"] as const) {
    if (hasMeaningfulValue(params.pack[field])) {
      candidateFields.push(field);
    }
  }

  const render = (fields: WorkflowPackPromptField[], omitted: WorkflowPackPromptField[]): string => {
    const lines: string[] = [
      "[Workflow Pack Effective Configuration]",
      "- This block is the authoritative source for workflow pack detail rules for this task run. If it differs from generic pack guidance above, follow this block.",
    ];
    if (params.source === "db_fallback") {
      lines.push("- Source: legacy DB fallback (stored snapshot unavailable for this task).");
    } else {
      lines.push("- Source: task snapshot.");
    }
    if (omitted.length > 0) {
      lines.push(`- Omitted due to prompt budget: ${omitted.join(", ")}`);
    }
    for (const field of fields) {
      lines.push(`[${WORKFLOW_PACK_PROMPT_FIELD_LABELS[field]}]`);
      lines.push(stringifyDeterministicJson(params.pack[field]));
    }
    return lines.join("\n");
  };

  const retained = [...candidateFields];
  const omitted: WorkflowPackPromptField[] = [];
  let block = render(retained, omitted);
  for (const field of WORKFLOW_PACK_PROMPT_OMISSION_ORDER) {
    if (block.length <= maxChars) break;
    const index = retained.indexOf(field);
    if (index < 0) continue;
    retained.splice(index, 1);
    omitted.push(field);
    block = render(retained, omitted);
  }
  return block;
}

export function resolveRuntimeWorkflowPack(params: {
  db: DbLike;
  workflowPackKey?: string | null;
  workflowMetaJson?: unknown;
}): RuntimeWorkflowPackResolution {
  const meta = parseWorkflowMetaObject(params.workflowMetaJson);
  const snapshot = normalizeSnapshotPack(meta.effective_pack_snapshot);
  if (snapshot) {
    return {
      pack: snapshot,
      source: "snapshot",
    };
  }

  const row = loadWorkflowPackRow(params.db, params.workflowPackKey);
  if (!row) {
    return {
      pack: null,
      source: "none",
    };
  }

  return {
    pack: toEffectiveWorkflowPack(row),
    source: "db_fallback",
  };
}

export function buildRuntimeWorkflowPackPromptBlock(params: {
  db: DbLike;
  workflowPackKey?: string | null;
  workflowMetaJson?: unknown;
  maxChars?: number;
}): string {
  const resolved = resolveRuntimeWorkflowPack(params);
  if (!resolved.pack || resolved.source === "none") return "";
  return renderWorkflowPackPromptBlock({
    pack: resolved.pack,
    source: resolved.source,
    maxChars: params.maxChars,
  });
}

export function buildRuntimeWorkflowPackPromptSections(params: {
  db: DbLike;
  workflowPackKey?: string | null;
  workflowMetaJson?: unknown;
  workflowPackGuidance?: string | null;
  maxChars?: number;
}): string[] {
  const sections: string[] = [];
  const guidance = typeof params.workflowPackGuidance === "string" ? params.workflowPackGuidance.trim() : "";
  if (guidance) {
    sections.push(`\n[Workflow Pack Execution Rules]\n${guidance}`);
  }
  const block = buildRuntimeWorkflowPackPromptBlock(params);
  if (block) {
    sections.push(`\n${block}`);
  }
  return sections;
}
