import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKFLOW_PACK_KEY, isWorkflowPackKey, type WorkflowPackKey } from "./definitions.ts";
import { readProjectWorkflowDefaultPackKey } from "./project-config.ts";

type DbLike = Pick<DatabaseSync, "prepare">;
export type TaskWorkflowPackSource = "explicit" | "file_default" | "project_default" | "fallback_default";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePackKey(value: unknown): WorkflowPackKey | null {
  const text = normalizeText(value);
  return isWorkflowPackKey(text) ? text : null;
}

export function resolveProjectDefaultPackKey(db: DbLike, projectId: string | null | undefined): WorkflowPackKey | null {
  const id = normalizeText(projectId);
  if (!id) return null;
  const row = db.prepare("SELECT default_pack_key FROM projects WHERE id = ? LIMIT 1").get(id) as
    | { default_pack_key?: unknown }
    | undefined;
  return normalizePackKey(row?.default_pack_key);
}

export function resolveProjectPathById(db: DbLike, projectId: string | null | undefined): string | null {
  const id = normalizeText(projectId);
  if (!id) return null;
  const row = db.prepare("SELECT project_path FROM projects WHERE id = ? LIMIT 1").get(id) as
    | { project_path?: unknown }
    | undefined;
  const projectPath = normalizeText(row?.project_path);
  return projectPath || null;
}

export function resolveTaskPackKeyById(db: DbLike, taskId: string | null | undefined): WorkflowPackKey | null {
  const id = normalizeText(taskId);
  if (!id) return null;
  const row = db.prepare("SELECT workflow_pack_key FROM tasks WHERE id = ? LIMIT 1").get(id) as
    | { workflow_pack_key?: unknown }
    | undefined;
  return normalizePackKey(row?.workflow_pack_key);
}

export function resolveTaskWorkflowPackSelection(params: {
  db: DbLike;
  explicitPackKey?: unknown;
  projectId?: string | null;
  projectPath?: string | null;
  fallbackPackKey?: WorkflowPackKey;
}): { packKey: WorkflowPackKey; source: TaskWorkflowPackSource; warnings: string[] } {
  const { db, explicitPackKey, projectId, projectPath, fallbackPackKey } = params;
  const explicit = normalizePackKey(explicitPackKey);
  if (explicit) {
    return { packKey: explicit, source: "explicit", warnings: [] };
  }

  const resolvedProjectPath = normalizeText(projectPath) || resolveProjectPathById(db, projectId);
  if (resolvedProjectPath) {
    const fileDefault = readProjectWorkflowDefaultPackKey(resolvedProjectPath);
    if (fileDefault.packKey) {
      return { packKey: fileDefault.packKey, source: "file_default", warnings: fileDefault.warnings };
    }
    const projectDefault = resolveProjectDefaultPackKey(db, projectId);
    if (projectDefault) {
      return { packKey: projectDefault, source: "project_default", warnings: fileDefault.warnings };
    }
    return {
      packKey: fallbackPackKey || DEFAULT_WORKFLOW_PACK_KEY,
      source: "fallback_default",
      warnings: fileDefault.warnings,
    };
  }

  const projectDefault = resolveProjectDefaultPackKey(db, projectId);
  if (projectDefault) {
    return { packKey: projectDefault, source: "project_default", warnings: [] };
  }

  return {
    packKey: fallbackPackKey || DEFAULT_WORKFLOW_PACK_KEY,
    source: "fallback_default",
    warnings: [],
  };
}

export function resolveWorkflowPackKeyForTask(params: {
  db: DbLike;
  explicitPackKey?: unknown;
  sourceTaskPackKey?: unknown;
  sourceTaskId?: string | null;
  projectId?: string | null;
  fallbackPackKey?: WorkflowPackKey;
}): WorkflowPackKey {
  const { db, explicitPackKey, sourceTaskPackKey, sourceTaskId, projectId, fallbackPackKey } = params;
  return (
    normalizePackKey(explicitPackKey) ||
    normalizePackKey(sourceTaskPackKey) ||
    resolveTaskPackKeyById(db, sourceTaskId) ||
    resolveProjectDefaultPackKey(db, projectId) ||
    fallbackPackKey ||
    DEFAULT_WORKFLOW_PACK_KEY
  );
}
