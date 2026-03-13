import type { APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type E2ECleanupTargets = {
  apiProviderIds?: string[];
  subtaskIds?: string[];
  taskIds?: string[];
  agentIds?: string[];
  departmentIds?: string[];
  projectIds?: string[];
};

function uniqueIds(ids: Array<string | null | undefined> | undefined): string[] {
  if (!ids) return [];
  return Array.from(new Set(ids.map((id) => String(id ?? "").trim()).filter((id) => id.length > 0)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function deleteById(
  request: APIRequestContext,
  routePrefix: string,
  ids: string[],
  errors: string[],
): Promise<void> {
  for (const id of ids) {
    try {
      const response = await request.delete(`${routePrefix}/${id}`);
      if (response.ok() || response.status() === 404) continue;
      const text = await response.text();
      errors.push(`${routePrefix}/${id} -> ${response.status()}: ${text.slice(0, 300)}`);
    } catch (error) {
      errors.push(`${routePrefix}/${id} -> ${String(error)}`);
    }
  }
}

async function waitForTaskDeletion(request: APIRequestContext, taskIds: string[], errors: string[]): Promise<void> {
  for (const id of taskIds) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      try {
        const response = await request.get(`/api/tasks/${id}`);
        if (response.status() === 404) break;
      } catch {
        break;
      }
      await sleep(200);
    }

    try {
      const verify = await request.get(`/api/tasks/${id}`);
      if (verify.status() !== 404) {
        errors.push(`/api/tasks/${id} -> deletion not observed`);
      }
    } catch {
      // best-effort verification
    }
  }
}

function deleteSubtasksFromLocalE2EDb(subtaskIds: string[], errors: string[]): void {
  if (subtaskIds.length === 0) return;

  const dbPath = path.resolve(process.cwd(), ".tmp", "e2e-runtime", "claw-empire.e2e.sqlite");
  if (!fs.existsSync(dbPath)) return;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    const placeholders = subtaskIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM subtasks WHERE id IN (${placeholders})`).run(...subtaskIds);
  } catch (error) {
    errors.push(`subtasks(local-db) -> ${String(error)}`);
  } finally {
    db?.close();
  }
}

export async function cleanupE2EResources(request: APIRequestContext, targets: E2ECleanupTargets): Promise<void> {
  const errors: string[] = [];
  const apiProviderIds = uniqueIds(targets.apiProviderIds);
  const taskIds = uniqueIds(targets.taskIds);
  const subtaskIds = uniqueIds(targets.subtaskIds);
  const projectIds = uniqueIds(targets.projectIds);
  const agentIds = uniqueIds(targets.agentIds);
  const departmentIds = uniqueIds(targets.departmentIds);

  await deleteById(request, "/api/tasks", taskIds, errors);
  await waitForTaskDeletion(request, taskIds, errors);
  await sleep(300);
  deleteSubtasksFromLocalE2EDb(subtaskIds, errors);
  await deleteById(request, "/api/agents", agentIds, errors);
  await deleteById(request, "/api/api-providers", apiProviderIds, errors);
  await deleteById(request, "/api/projects", projectIds, errors);
  await deleteById(request, "/api/departments", departmentIds, errors);

  if (errors.length > 0) {
    throw new Error(`E2E cleanup failed:\n${errors.join("\n")}`);
  }
}
