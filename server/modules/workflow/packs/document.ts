import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKFLOW_PACK_SEEDS, isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";

type DbLike = Pick<DatabaseSync, "prepare" | "exec">;

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
  created_at: number;
  updated_at: number;
};

export type WorkflowPackDocumentPack = {
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

export type WorkflowPackExportDocument = {
  version: 1;
  exported_at: number;
  packs: WorkflowPackDocumentPack[];
};

export type WorkflowPackImportValidationResult =
  | {
      ok: true;
      packs: Array<WorkflowPackDocumentPack & { payload: string[] }>;
    }
  | {
      ok: false;
      error: string;
      field?: string;
      key?: string;
    };

function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeJsonStorageInput(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, error: "empty_json_text" };
    try {
      const parsed = JSON.parse(trimmed);
      return { ok: true, json: JSON.stringify(parsed) };
    } catch {
      return { ok: false, error: "invalid_json_text" };
    }
  }
  if (value === undefined) return { ok: false, error: "missing_json_value" };
  return { ok: true, json: JSON.stringify(value) };
}

function toDocumentPack(row: WorkflowPackRow): WorkflowPackDocumentPack {
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

function getSeedPack(key: WorkflowPackKey): WorkflowPackDocumentPack | null {
  const seed = DEFAULT_WORKFLOW_PACK_SEEDS.find((item) => item.key === key);
  if (!seed) return null;
  return {
    key: seed.key,
    name: seed.name,
    enabled: true,
    input_schema: seed.inputSchema,
    prompt_preset: seed.promptPreset,
    qa_rules: seed.qaRules,
    output_template: seed.outputTemplate,
    routing_keywords: seed.routingKeywords,
    cost_profile: seed.costProfile,
  };
}

export function buildWorkflowPackExportDocument(
  db: DbLike,
  exportedAt: number,
  key?: WorkflowPackKey,
): WorkflowPackExportDocument {
  const rows = key
    ? (db.prepare("SELECT * FROM workflow_packs WHERE key = ?").all(key) as WorkflowPackRow[])
    : (db.prepare("SELECT * FROM workflow_packs ORDER BY key ASC").all() as WorkflowPackRow[]);

  let packs = rows.map(toDocumentPack);
  if (packs.length <= 0) {
    if (key) {
      const seed = getSeedPack(key);
      packs = seed ? [seed] : [];
    } else {
      packs = DEFAULT_WORKFLOW_PACK_SEEDS.map((seed) => ({
        key: seed.key,
        name: seed.name,
        enabled: true,
        input_schema: seed.inputSchema,
        prompt_preset: seed.promptPreset,
        qa_rules: seed.qaRules,
        output_template: seed.outputTemplate,
        routing_keywords: seed.routingKeywords,
        cost_profile: seed.costProfile,
      }));
    }
  }

  return {
    version: 1,
    exported_at: exportedAt,
    packs,
  };
}

export function validateWorkflowPackImportDocument(document: unknown): WorkflowPackImportValidationResult {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, error: "invalid_import_document" };
  }
  const root = document as Record<string, unknown>;
  if (Number(root.version) !== 1) {
    return { ok: false, error: "unsupported_version", field: "version" };
  }
  if (!Array.isArray(root.packs) || root.packs.length <= 0) {
    return { ok: false, error: "packs_required", field: "packs" };
  }

  const seen = new Set<string>();
  const normalizedPacks: Array<WorkflowPackDocumentPack & { payload: string[] }> = [];
  for (const entry of root.packs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "invalid_pack_entry", field: "packs" };
    }
    const pack = entry as Record<string, unknown>;
    const key = typeof pack.key === "string" ? pack.key.trim() : "";
    if (!isWorkflowPackKey(key)) {
      return { ok: false, error: "unknown_pack_key", field: "key", key };
    }
    if (seen.has(key)) {
      return { ok: false, error: "duplicate_pack_key", field: "key", key };
    }
    seen.add(key);

    const name = typeof pack.name === "string" ? pack.name.trim() : "";
    if (!name) {
      return { ok: false, error: "name_required", field: "name", key };
    }

    const fields: Array<[keyof WorkflowPackDocumentPack, string]> = [
      ["input_schema", "input_schema"],
      ["prompt_preset", "prompt_preset"],
      ["qa_rules", "qa_rules"],
      ["output_template", "output_template"],
      ["routing_keywords", "routing_keywords"],
      ["cost_profile", "cost_profile"],
    ];
    const payload: string[] = [];
    for (const [prop, field] of fields) {
      const normalized = normalizeJsonStorageInput(pack[prop]);
      if (!normalized.ok) {
        return { ok: false, error: "invalid_json_field", field, key };
      }
      payload.push(normalized.json);
    }

    normalizedPacks.push({
      key,
      name,
      enabled: pack.enabled === false || pack.enabled === 0 || String(pack.enabled) === "0" ? false : true,
      input_schema: pack.input_schema,
      prompt_preset: pack.prompt_preset,
      qa_rules: pack.qa_rules,
      output_template: pack.output_template,
      routing_keywords: pack.routing_keywords,
      cost_profile: pack.cost_profile,
      payload,
    });
  }

  return { ok: true, packs: normalizedPacks };
}

export function importWorkflowPackDocument(db: DbLike, packs: Array<WorkflowPackDocumentPack & { payload: string[] }>, now: number): void {
  db.exec("BEGIN");
  try {
    const upsert = db.prepare(
      `
        INSERT INTO workflow_packs (
          key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json,
          output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          input_schema_json = excluded.input_schema_json,
          prompt_preset_json = excluded.prompt_preset_json,
          qa_rules_json = excluded.qa_rules_json,
          output_template_json = excluded.output_template_json,
          routing_keywords_json = excluded.routing_keywords_json,
          cost_profile_json = excluded.cost_profile_json,
          updated_at = excluded.updated_at
      `,
    );

    for (const pack of packs) {
      upsert.run(
        pack.key,
        pack.name,
        pack.enabled ? 1 : 0,
        pack.payload[0],
        pack.payload[1],
        pack.payload[2],
        pack.payload[3],
        pack.payload[4],
        pack.payload[5],
        now,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
