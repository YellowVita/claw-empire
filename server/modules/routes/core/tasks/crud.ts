import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { MeetingMinuteEntryRow, MeetingMinutesRow } from "../../shared/types.ts";
import { isWorkflowPackKey } from "../../../workflow/packs/definitions.ts";
import { buildEffectiveWorkflowPack } from "../../../workflow/packs/effective-pack.ts";
import { resolveProjectPathById, resolveTaskWorkflowPackSelection } from "../../../workflow/packs/task-pack-resolver.ts";
import { createProjectPathPolicy } from "../projects/path-policy.ts";
import {
  buildTaskQualityPayload,
  seedTaskQualityItemsFromWorkflowMeta,
} from "./quality.ts";
import { deleteTaskRetryQueueRow } from "../../../workflow/orchestration/task-execution-policy.ts";
import {
  clearDevelopmentHandoffMetadata,
  decorateTaskWithDevelopmentHandoff,
  readDevelopmentHandoffFromTaskLike,
  upsertDevelopmentHandoffMetadata,
} from "../../../workflow/orchestration/development-handoff.ts";
import { ORCHESTRATION_V2_VERSION } from "../../../workflow/orchestration/subtask-orchestration-v2.ts";

export type TaskCrudRouteDeps = Pick<
  RuntimeContext,
  | "app"
  | "db"
  | "nowMs"
  | "firstQueryValue"
  | "reconcileCrossDeptSubtasks"
  | "normalizeTextField"
  | "recordTaskCreationAudit"
  | "appendTaskLog"
  | "broadcast"
  | "setTaskCreationAuditCompletion"
  | "clearTaskWorkflowState"
  | "endTaskExecutionSession"
  | "activeProcesses"
  | "stopRequestModeByTask"
  | "stopProgressTimer"
  | "stopRequestedTasks"
  | "killPidTree"
  | "taskWorktrees"
  | "rollbackTaskWorktree"
  | "logsDir"
>;

export function registerTaskCrudRoutes(deps: TaskCrudRouteDeps): void {
  const {
    app,
    db,
    nowMs,
    firstQueryValue,
    reconcileCrossDeptSubtasks,
    normalizeTextField,
    recordTaskCreationAudit,
    appendTaskLog,
    broadcast,
    setTaskCreationAuditCompletion,
    clearTaskWorkflowState,
    endTaskExecutionSession,
    activeProcesses,
    stopRequestModeByTask,
    stopProgressTimer,
    stopRequestedTasks,
    killPidTree,
    taskWorktrees,
    rollbackTaskWorktree,
    logsDir,
  } = deps;

  const {
    isRelativeProjectPathInput,
    normalizeProjectPathInput,
    isPathInsideAllowedRoots,
    normalizePathForScopeCompare,
  } = createProjectPathPolicy({ normalizeTextField });

  function validateTaskProjectPathInput(
    raw: unknown,
    requiredError: "project_path_required" | "invalid_task_project_path" = "project_path_required",
  ): { ok: true; path: string } | { ok: false; status: number; error: string } {
    const normalized = normalizeProjectPathInput(raw);
    if (!normalized) {
      return {
        ok: false,
        status: 400,
        error: isRelativeProjectPathInput(raw) ? "relative_project_path_not_allowed" : requiredError,
      };
    }
    if (!isPathInsideAllowedRoots(normalized)) {
      return { ok: false, status: 403, error: "project_path_outside_allowed_roots" };
    }
    return { ok: true, path: normalized };
  }

  function pathsMatch(left: string, right: string): boolean {
    return normalizePathForScopeCompare(left) === normalizePathForScopeCompare(right);
  }

  function resolveCanonicalProjectPath(
    projectId: string,
  ): { ok: true; path: string } | { ok: false; status: number; error: string } {
    const project = db
      .prepare("SELECT id, project_path FROM projects WHERE id = ?")
      .get(projectId) as { id: string; project_path: string | null } | undefined;
    if (!project) return { ok: false, status: 400, error: "project_not_found" };
    return validateTaskProjectPathInput(project.project_path, "invalid_task_project_path");
  }

  function warnOnLegacyInvalidTaskPaths(): void {
    const rows = db
      .prepare("SELECT id, project_path FROM tasks WHERE project_path IS NOT NULL AND TRIM(project_path) != ''")
      .all() as Array<{ id: string; project_path: string | null }>;
    let invalidCount = 0;
    for (const row of rows) {
      const result = validateTaskProjectPathInput(row.project_path, "invalid_task_project_path");
      if (!result.ok) invalidCount += 1;
    }
    if (invalidCount > 0) {
      console.warn(`[Claw-Empire] task_path_audit invalid_task_project_paths=${invalidCount}`);
    }
  }

  function canEnterReview(taskId: string): {
    ok: boolean;
    items: Array<Record<string, unknown>>;
    summary: ReturnType<typeof buildTaskQualityPayload>["summary"];
  } {
    const quality = buildTaskQualityPayload(db as any, taskId);
    return {
      ok: !quality.summary.blocked_review,
      items: quality.items,
      summary: quality.summary,
    };
  }

  function getTaskResetReason(nextStatus: string): string | null {
    if (nextStatus === "cancelled") return "task_status_cancelled";
    if (nextStatus === "inbox") return "task_status_inbox_reset";
    if (nextStatus === "done") return "task_status_done_override";
    return null;
  }

  function logWorkflowPackSelectionWarnings(warnings: string[], context: string): void {
    for (const warning of warnings) {
      console.warn(`[workflow-pack/${context}] ${warning}`);
    }
  }

  function parseWorkflowMetaObject(raw: unknown, context: string): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { ...(parsed as Record<string, unknown>) };
        }
        console.warn(`[workflow-pack/${context}] workflow_meta_json is not an object; using empty object for snapshot merge`);
        return {};
      } catch {
        console.warn(`[workflow-pack/${context}] workflow_meta_json parse failed; using empty object for snapshot merge`);
        return {};
      }
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
      return { ...(raw as Record<string, unknown>) };
    }
    console.warn(`[workflow-pack/${context}] workflow_meta_json is not an object; using empty object for snapshot merge`);
    return {};
  }

  function buildWorkflowMetaJsonWithPackSnapshot(params: {
    rawWorkflowMeta: unknown;
    packKey: string;
    projectId?: string | null;
    projectPath?: string | null;
    context: string;
  }): string {
    const normalizedProjectPath =
      normalizeProjectPathInput(params.projectPath) ??
      resolveProjectPathById(db as any, params.projectId);
    const effectivePack = isWorkflowPackKey(params.packKey)
      ? buildEffectiveWorkflowPack({
          db: db as any,
          packKey: params.packKey,
          projectPath: normalizedProjectPath,
        })
      : {
          pack: null,
          override_applied: false,
          override_fields: [],
          source: "db" as const,
          warnings: [`workflow pack '${params.packKey}' is invalid`],
        };

    logWorkflowPackSelectionWarnings(effectivePack.warnings, params.context);
    const nextMeta = parseWorkflowMetaObject(params.rawWorkflowMeta, params.context);
    nextMeta.pack_override_source = effectivePack.override_applied ? "file" : null;
    nextMeta.pack_override_fields = effectivePack.override_fields;
    nextMeta.effective_pack_snapshot = effectivePack.pack;
    return JSON.stringify(nextMeta);
  }

  warnOnLegacyInvalidTaskPaths();

  function stopActiveTaskProcess(taskId: string): void {
    const activeChild = activeProcesses.get(taskId);
    if (!activeChild?.pid) return;

    stopRequestedTasks.add(taskId);
    stopRequestModeByTask.set(taskId, "cancel");
    stopProgressTimer(taskId);
    if (activeChild.pid < 0) {
      activeChild.kill?.();
    } else {
      killPidTree(activeChild.pid);
    }
    activeProcesses.delete(taskId);
  }

  function releaseLinkedAgents(taskId: string): void {
    const linkedAgents = db.prepare("SELECT id FROM agents WHERE current_task_id = ?").all(taskId) as Array<{
      id: string;
    }>;
    db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE current_task_id = ?").run(taskId);
    for (const linked of linkedAgents) {
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(linked.id);
      if (updatedAgent) broadcast("agent_status", updatedAgent);
    }
  }

  function rollbackTaskIfPresent(taskId: string, reason: string | null): boolean {
    if (!reason || !taskWorktrees.has(taskId)) return false;
    return rollbackTaskWorktree(taskId, reason);
  }

  function normalizeQualityItemPatch(raw: Record<string, unknown>, now: number): Record<string, unknown> | null {
    const next: Record<string, unknown> = {};
    if ("status" in raw) {
      const status = typeof raw.status === "string" ? raw.status.trim() : "";
      if (!["pending", "passed", "failed", "waived"].includes(status)) return null;
      next.status = status;
      next.completed_at = status === "passed" || status === "waived" ? now : null;
    }
    if ("details" in raw) {
      next.details = typeof raw.details === "string" && raw.details.trim() ? raw.details.trim() : null;
    }
    if ("evidence_markdown" in raw) {
      next.evidence_markdown =
        typeof raw.evidence_markdown === "string" && raw.evidence_markdown.trim() ? raw.evidence_markdown.trim() : null;
    }
    if ("required" in raw) {
      next.required = raw.required === false || raw.required === 0 ? 0 : 1;
    }
    if ("sort_order" in raw) {
      const value = Number(raw.sort_order);
      if (!Number.isFinite(value)) return null;
      next.sort_order = Math.trunc(value);
    }
    return next;
  }

  app.get("/api/tasks", (req, res) => {
    reconcileCrossDeptSubtasks();
    const statusFilter = firstQueryValue(req.query.status);
    const deptFilter = firstQueryValue(req.query.department_id);
    const agentFilter = firstQueryValue(req.query.agent_id);
    const projectFilter = firstQueryValue(req.query.project_id);
    const workflowPackFilter = normalizeTextField(firstQueryValue(req.query.workflow_pack_key));

    if (workflowPackFilter && !isWorkflowPackKey(workflowPackFilter)) {
      return res.status(400).json({ error: "invalid_workflow_pack_key" });
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (statusFilter) {
      conditions.push("t.status = ?");
      params.push(statusFilter);
    }
    if (deptFilter) {
      conditions.push("t.department_id = ?");
      params.push(deptFilter);
    }
    if (agentFilter) {
      conditions.push("t.assigned_agent_id = ?");
      params.push(agentFilter);
    }
    if (projectFilter) {
      conditions.push("t.project_id = ?");
      params.push(projectFilter);
    }
    if (workflowPackFilter) {
      conditions.push("t.workflow_pack_key = ?");
      params.push(workflowPackFilter);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const subtaskTotalExpr = `(
    (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id)
    +
    (SELECT COUNT(*)
     FROM tasks c
     WHERE c.source_task_id = t.id
       AND NOT EXISTS (
         SELECT 1
         FROM subtasks s2
         WHERE s2.task_id = t.id
           AND s2.delegated_task_id = c.id
       )
    )
  )`;
    const subtaskDoneExpr = `(
    (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status = 'done')
    +
    (SELECT COUNT(*)
     FROM tasks c
     WHERE c.source_task_id = t.id
       AND c.status = 'done'
       AND NOT EXISTS (
         SELECT 1
         FROM subtasks s2
         WHERE s2.task_id = t.id
           AND s2.delegated_task_id = c.id
       )
    )
  )`;

    let tasks: unknown[];
    try {
      tasks = db
        .prepare(
          `
      SELECT t.*,
        a.name AS agent_name,
        a.avatar_emoji AS agent_avatar,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.icon, d.icon) AS department_icon,
        p.name AS project_name,
        p.core_goal AS project_core_goal,
        ${subtaskTotalExpr} AS subtask_total,
        ${subtaskDoneExpr} AS subtask_done
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = COALESCE(t.workflow_pack_key, 'development')
       AND opd.department_id = t.department_id
      LEFT JOIN departments d ON t.department_id = d.id
      LEFT JOIN projects p ON t.project_id = p.id
      ${where}
      ORDER BY t.priority DESC, t.updated_at DESC
    `,
        )
        .all(...(params as SQLInputValue[]));
    } catch {
      tasks = db
        .prepare(
          `
      SELECT t.*,
        a.name AS agent_name,
        a.avatar_emoji AS agent_avatar,
        d.name AS department_name,
        d.icon AS department_icon,
        p.name AS project_name,
        p.core_goal AS project_core_goal,
        ${subtaskTotalExpr} AS subtask_total,
        ${subtaskDoneExpr} AS subtask_done
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      LEFT JOIN departments d ON t.department_id = d.id
      LEFT JOIN projects p ON t.project_id = p.id
      ${where}
      ORDER BY t.priority DESC, t.updated_at DESC
    `,
        )
        .all(...(params as SQLInputValue[]));
    }

    res.json({ tasks: tasks.map((task) => decorateTaskWithDevelopmentHandoff(task as Record<string, unknown>)) });
  });

  app.post("/api/tasks", (req, res) => {
    const body = req.body ?? {};
    const id = randomUUID();
    const t = nowMs();

    const title = (body as any).title;
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title_required" });
    }

    const requestedProjectId = normalizeTextField((body as any).project_id);
    let resolvedProjectId: string | null = null;
    let resolvedProjectPath: string | null = null;
    let resolvedProjectDefaultPackKey: string | null = null;
    const hasProjectPathInput = "project_path" in (body as any);
    const inputProjectPath = hasProjectPathInput ? validateTaskProjectPathInput((body as any).project_path) : null;
    if (inputProjectPath && !inputProjectPath.ok) {
      return res.status(inputProjectPath.status).json({ error: inputProjectPath.error });
    }

    if (requestedProjectId) {
      const project = db
        .prepare("SELECT id, project_path, default_pack_key FROM projects WHERE id = ?")
        .get(requestedProjectId) as
        | {
            id: string;
            project_path: string;
            default_pack_key: string | null;
          }
        | undefined;
      if (!project) return res.status(400).json({ error: "project_not_found" });
      const canonicalProjectPath = validateTaskProjectPathInput(project.project_path, "invalid_task_project_path");
      if (!canonicalProjectPath.ok) {
        return res.status(canonicalProjectPath.status).json({ error: canonicalProjectPath.error });
      }
      if (inputProjectPath?.ok && !pathsMatch(inputProjectPath.path, canonicalProjectPath.path)) {
        return res.status(409).json({ error: "conflicting_project_path_sources" });
      }
      resolvedProjectId = project.id;
      resolvedProjectPath = canonicalProjectPath.path;
      resolvedProjectDefaultPackKey = normalizeTextField(project.default_pack_key);
    } else if (inputProjectPath?.ok) {
      resolvedProjectPath = inputProjectPath.path;
      const projectByPath = db
        .prepare(
          "SELECT id, project_path, default_pack_key FROM projects WHERE project_path = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1",
        )
        .get(resolvedProjectPath) as
        | { id: string; project_path: string; default_pack_key: string | null }
        | undefined;
      if (projectByPath) {
        resolvedProjectId = projectByPath.id;
        const canonicalProjectPath = validateTaskProjectPathInput(projectByPath.project_path, "invalid_task_project_path");
        if (!canonicalProjectPath.ok) {
          return res.status(canonicalProjectPath.status).json({ error: canonicalProjectPath.error });
        }
        resolvedProjectPath = canonicalProjectPath.path;
        resolvedProjectDefaultPackKey = normalizeTextField(projectByPath.default_pack_key);
      }
    }

    const workflowPackSelection = resolveTaskWorkflowPackSelection({
      db: db as any,
      explicitPackKey: (body as any).workflow_pack_key,
      projectId: resolvedProjectId,
      projectPath: resolvedProjectPath,
      fallbackPackKey: isWorkflowPackKey(resolvedProjectDefaultPackKey) ? resolvedProjectDefaultPackKey : undefined,
    });
    logWorkflowPackSelectionWarnings(workflowPackSelection.warnings, "task-create");

    const workflowMetaJson = buildWorkflowMetaJsonWithPackSnapshot({
      rawWorkflowMeta: (body as any).workflow_meta_json,
      packKey: workflowPackSelection.packKey,
      projectId: resolvedProjectId,
      projectPath: resolvedProjectPath,
      context: "task-create",
    });
    const useDevelopmentTaskOrchestrationV2 = workflowPackSelection.packKey === "development";

    db.prepare(
      `
    INSERT INTO tasks (
      id, title, description, department_id, assigned_agent_id, project_id,
      status, priority, task_type, workflow_pack_key, workflow_pack_source, workflow_meta_json, output_format,
      orchestration_version, orchestration_stage,
      project_path, base_branch, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    ).run(
      id,
      title,
      (body as any).description ?? null,
      (body as any).department_id ?? null,
      (body as any).assigned_agent_id ?? null,
      resolvedProjectId,
      (body as any).status ?? "inbox",
      (body as any).priority ?? 0,
      (body as any).task_type ?? "general",
      workflowPackSelection.packKey,
      workflowPackSelection.source,
      workflowMetaJson,
      typeof (body as any).output_format === "string" ? (body as any).output_format : null,
      useDevelopmentTaskOrchestrationV2 ? ORCHESTRATION_V2_VERSION : null,
      useDevelopmentTaskOrchestrationV2 ? "owner_prep" : null,
      resolvedProjectPath,
      (body as any).base_branch ?? null,
      t,
      t,
    );
    seedTaskQualityItemsFromWorkflowMeta(
      db as any,
      id,
      workflowMetaJson,
      t,
    );
    if (workflowPackSelection.packKey === "development") {
      upsertDevelopmentHandoffMetadata(db as any, {
        taskId: id,
        state: "queued",
        updatedAt: t,
      });
    }
    recordTaskCreationAudit({
      taskId: id,
      taskTitle: title,
      taskStatus: String((body as any).status ?? "inbox"),
      departmentId: typeof (body as any).department_id === "string" ? (body as any).department_id : null,
      assignedAgentId: typeof (body as any).assigned_agent_id === "string" ? (body as any).assigned_agent_id : null,
      taskType: typeof (body as any).task_type === "string" ? (body as any).task_type : "general",
      projectPath: resolvedProjectPath,
      trigger: "api.tasks.create",
      triggerDetail: "POST /api/tasks",
      actorType: "api_client",
      req,
      body: typeof body === "object" && body ? (body as Record<string, unknown>) : null,
    });

    if (resolvedProjectId) {
      db.prepare("UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?").run(t, t, resolvedProjectId);
    }

    appendTaskLog(id, "system", `Task created: ${title}`);

    const task = decorateTaskWithDevelopmentHandoff(
      (db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) ?? {}) as Record<string, unknown>,
    );
    broadcast("task_update", task);
    res.json({ id, task });
  });

  app.get("/api/tasks/:id", (req, res) => {
    const id = String(req.params.id);
    reconcileCrossDeptSubtasks(id);
    const subtaskTotalExpr = `(
    (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id)
    +
    (SELECT COUNT(*)
     FROM tasks c
     WHERE c.source_task_id = t.id
       AND NOT EXISTS (
         SELECT 1
         FROM subtasks s2
         WHERE s2.task_id = t.id
           AND s2.delegated_task_id = c.id
       )
    )
  )`;
    const subtaskDoneExpr = `(
    (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status = 'done')
    +
    (SELECT COUNT(*)
     FROM tasks c
     WHERE c.source_task_id = t.id
       AND c.status = 'done'
       AND NOT EXISTS (
         SELECT 1
         FROM subtasks s2
         WHERE s2.task_id = t.id
           AND s2.delegated_task_id = c.id
       )
    )
  )`;
    let task: unknown;
    try {
      task = db
        .prepare(
          `
      SELECT t.*,
        a.name AS agent_name,
        a.avatar_emoji AS agent_avatar,
        a.cli_provider AS agent_provider,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.icon, d.icon) AS department_icon,
        p.name AS project_name,
        p.core_goal AS project_core_goal,
        ${subtaskTotalExpr} AS subtask_total,
        ${subtaskDoneExpr} AS subtask_done
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = COALESCE(t.workflow_pack_key, 'development')
       AND opd.department_id = t.department_id
      LEFT JOIN departments d ON t.department_id = d.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = ?
    `,
        )
        .get(id);
    } catch {
      task = db
        .prepare(
          `
      SELECT t.*,
        a.name AS agent_name,
        a.avatar_emoji AS agent_avatar,
        a.cli_provider AS agent_provider,
        d.name AS department_name,
        d.icon AS department_icon,
        p.name AS project_name,
        p.core_goal AS project_core_goal,
        ${subtaskTotalExpr} AS subtask_total,
        ${subtaskDoneExpr} AS subtask_done
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      LEFT JOIN departments d ON t.department_id = d.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = ?
    `,
        )
        .get(id);
    }
    if (!task) return res.status(404).json({ error: "not_found" });

    const logs = db.prepare("SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT 200").all(id);
    const subtasks = db.prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY created_at").all(id);
    const quality = buildTaskQualityPayload(db as any, id);

    res.json({
      task: decorateTaskWithDevelopmentHandoff(
        {
          ...(task as Record<string, unknown>),
          quality_summary: quality.summary,
        } as Record<string, unknown>,
      ),
      logs,
      subtasks,
    });
  });

  app.get("/api/tasks/:id/quality", (req, res) => {
    const id = String(req.params.id);
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
    if (!task) return res.status(404).json({ error: "not_found" });
    res.json(buildTaskQualityPayload(db as any, id));
  });

  app.patch("/api/tasks/:id/quality/items/:itemId", (req, res) => {
    const id = String(req.params.id);
    const itemId = String(req.params.itemId);
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
    if (!task) return res.status(404).json({ error: "not_found" });

    const item = db.prepare("SELECT id FROM task_quality_items WHERE id = ? AND task_id = ?").get(itemId, id);
    if (!item) return res.status(404).json({ error: "quality_item_not_found" });

    const patch = normalizeQualityItemPatch((req.body ?? {}) as Record<string, unknown>, nowMs());
    if (!patch || Object.keys(patch).length <= 0) {
      return res.status(400).json({ error: "invalid_quality_patch" });
    }

    const updates = Object.keys(patch)
      .map((field) => `${field} = ?`)
      .join(", ");
    const values = Object.keys(patch).map((field) => patch[field]);
    db.prepare(`UPDATE task_quality_items SET ${updates}, updated_at = ? WHERE id = ? AND task_id = ?`).run(
      ...(values as SQLInputValue[]),
      nowMs(),
      itemId,
      id,
    );

    const updated = db.prepare("SELECT * FROM task_quality_items WHERE id = ? AND task_id = ?").get(itemId, id);
    res.json({ ok: true, item: updated, summary: buildTaskQualityPayload(db as any, id).summary });
  });

  app.get("/api/tasks/:id/meeting-minutes", (req, res) => {
    const id = String(req.params.id);
    const task = db.prepare("SELECT id, source_task_id FROM tasks WHERE id = ?").get(id) as
      | { id: string; source_task_id: string | null }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const taskIds = [id];
    if (task.source_task_id) taskIds.push(task.source_task_id);

    const meetings = db
      .prepare(
        `SELECT * FROM meeting_minutes WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY started_at DESC, round DESC`,
      )
      .all(...taskIds) as unknown as MeetingMinutesRow[];

    const data = meetings.map((meeting) => {
      const entries = db
        .prepare("SELECT * FROM meeting_minute_entries WHERE meeting_id = ? ORDER BY seq ASC, id ASC")
        .all(meeting.id) as unknown as MeetingMinuteEntryRow[];
      return { ...meeting, entries };
    });

    res.json({ meetings: data });
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const id = String(req.params.id);
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          status: string;
          project_id: string | null;
          project_path: string | null;
          workflow_pack_key: string | null;
          workflow_pack_source: string | null;
          workflow_meta_json: string | null;
        }
      | undefined;
    if (!existing) return res.status(404).json({ error: "not_found" });

    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    const explicitWorkflowPackKey = "workflow_pack_key" in body ? normalizeTextField(body.workflow_pack_key) : null;
    if ("workflow_pack_key" in body) {
      if (!explicitWorkflowPackKey || !isWorkflowPackKey(explicitWorkflowPackKey)) {
        return res.status(400).json({ error: "invalid_workflow_pack_key" });
      }
      body.workflow_pack_key = explicitWorkflowPackKey;
    }
    if ("workflow_meta_json" in body) {
      const rawWorkflowMeta = body.workflow_meta_json;
      if (rawWorkflowMeta === null) {
        body.workflow_meta_json = null;
      } else if (typeof rawWorkflowMeta === "string") {
        body.workflow_meta_json = rawWorkflowMeta;
      } else {
        body.workflow_meta_json = JSON.stringify(rawWorkflowMeta);
      }
    }
    if ("output_format" in body && body.output_format !== null && typeof body.output_format !== "string") {
      return res.status(400).json({ error: "invalid_output_format" });
    }
    const nextStatus = typeof (body as any).status === "string" ? (body as any).status : null;
    if (nextStatus === "review" && (existing.status === "in_progress" || existing.status === "collaborating")) {
      const qualityGate = canEnterReview(id);
      if (!qualityGate.ok) {
        return res.status(409).json({
          error: "quality_gate_failed",
          items: qualityGate.items,
          summary: qualityGate.summary,
        });
      }
    }
    const resetReason = nextStatus ? getTaskResetReason(nextStatus) : null;
    const shouldResetTask = Boolean(nextStatus && nextStatus !== existing.status && resetReason);
    if (shouldResetTask) {
      stopActiveTaskProcess(id);
      rollbackTaskIfPresent(id, resetReason);
    }

    const allowedFields = [
      "title",
      "description",
      "department_id",
      "assigned_agent_id",
      "status",
      "priority",
      "task_type",
      "workflow_pack_key",
      "workflow_meta_json",
      "output_format",
      "result",
      "hidden",
    ];

    const updates: string[] = ["updated_at = ?"];
    const updateTs = nowMs();
    const params: unknown[] = [updateTs];
    let touchedProjectId: string | null = null;
    let nextProjectId = existing.project_id ?? null;
    let nextProjectPath = normalizeProjectPathInput(existing.project_path);
    const shouldResolveWorkflowPack =
      "workflow_pack_key" in body || "project_id" in body || "project_path" in body || "workflow_meta_json" in body;
    const hasProjectPathInput = "project_path" in (body as any);
    const requestedProjectId = "project_id" in (body as any) ? normalizeTextField((body as any).project_id) : undefined;
    const requestedProjectPath = hasProjectPathInput
      ? validateTaskProjectPathInput((body as any).project_path, "invalid_task_project_path")
      : null;

    if (requestedProjectPath && !requestedProjectPath.ok) {
      return res.status(requestedProjectPath.status).json({ error: requestedProjectPath.error });
    }

    for (const field of allowedFields) {
      if (field === "workflow_pack_key" && shouldResolveWorkflowPack) continue;
      if (field === "workflow_meta_json" && shouldResolveWorkflowPack) continue;
      if (field in body) {
        updates.push(`${field} = ?`);
        params.push(body[field]);
      }
    }

    if ("project_id" in (body as any)) {
      if (!requestedProjectId) {
        updates.push("project_id = ?");
        params.push(null);
        nextProjectId = null;
        if (!hasProjectPathInput) {
          updates.push("project_path = ?");
          params.push(null);
          nextProjectPath = null;
        }
      } else {
        const canonicalProjectPath = resolveCanonicalProjectPath(requestedProjectId);
        if (!canonicalProjectPath.ok) {
          return res.status(canonicalProjectPath.status).json({ error: canonicalProjectPath.error });
        }
        if (requestedProjectPath?.ok && !pathsMatch(requestedProjectPath.path, canonicalProjectPath.path)) {
          return res.status(409).json({ error: "conflicting_project_path_sources" });
        }
        updates.push("project_id = ?");
        params.push(requestedProjectId);
        touchedProjectId = requestedProjectId;
        nextProjectId = requestedProjectId;
        updates.push("project_path = ?");
        params.push(canonicalProjectPath.path);
        nextProjectPath = canonicalProjectPath.path;
      }
    }
    if (hasProjectPathInput && requestedProjectPath?.ok) {
      if (nextProjectId) {
        const canonicalProjectPath = resolveCanonicalProjectPath(nextProjectId);
        if (!canonicalProjectPath.ok) {
          return res.status(canonicalProjectPath.status).json({ error: canonicalProjectPath.error });
        }
        if (!pathsMatch(requestedProjectPath.path, canonicalProjectPath.path)) {
          return res.status(409).json({ error: "conflicting_project_path_sources" });
        }
        if (!updates.includes("project_path = ?")) {
          updates.push("project_path = ?");
          params.push(canonicalProjectPath.path);
        }
        nextProjectPath = canonicalProjectPath.path;
      } else {
        updates.push("project_path = ?");
        params.push(requestedProjectPath.path);
        nextProjectPath = requestedProjectPath.path;
      }
    }

    let resolvedWorkflowPackKey = existing.workflow_pack_key ?? null;
    if (shouldResolveWorkflowPack) {
      const selection =
        explicitWorkflowPackKey && isWorkflowPackKey(explicitWorkflowPackKey)
          ? {
              packKey: explicitWorkflowPackKey,
              source: "explicit" as const,
              warnings: [] as string[],
            }
          : resolveTaskWorkflowPackSelection({
              db: db as any,
              projectId: nextProjectId,
              projectPath: nextProjectPath,
            });
      logWorkflowPackSelectionWarnings(selection.warnings, "task-patch");
      resolvedWorkflowPackKey = selection.packKey;
      updates.push("workflow_pack_key = ?");
      params.push(selection.packKey);
      updates.push("workflow_pack_source = ?");
      params.push(selection.source);
      updates.push("workflow_meta_json = ?");
      params.push(
        buildWorkflowMetaJsonWithPackSnapshot({
          rawWorkflowMeta: "workflow_meta_json" in body ? body.workflow_meta_json : existing.workflow_meta_json,
          packKey: selection.packKey,
          projectId: nextProjectId,
          projectPath: nextProjectPath,
          context: "task-patch",
        }),
      );
    }

    if ((body as any).status === "done" && !("completed_at" in (body as any))) {
      updates.push("completed_at = ?");
      params.push(nowMs());
    }
    if ((body as any).status === "in_progress" && !("started_at" in (body as any))) {
      updates.push("started_at = ?");
      params.push(nowMs());
    }

    params.push(id);
    db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...(params as SQLInputValue[]));
    const updatedRow = (db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) ?? {}) as Record<string, unknown>;
    if (resolvedWorkflowPackKey === "development" && !readDevelopmentHandoffFromTaskLike(updatedRow)) {
      upsertDevelopmentHandoffMetadata(db as any, {
        taskId: id,
        state: "queued",
        updatedAt: updateTs,
      });
    } else if (shouldResolveWorkflowPack) {
      clearDevelopmentHandoffMetadata(db as any, {
        taskId: id,
        updatedAt: updateTs,
      });
    }
    if (touchedProjectId) {
      db.prepare("UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?").run(
        updateTs,
        updateTs,
        touchedProjectId,
      );
    }

    if (nextStatus) {
      setTaskCreationAuditCompletion(id, nextStatus === "done");
    }
    if (
      nextStatus &&
      (nextStatus === "cancelled" || nextStatus === "pending" || nextStatus === "done" || nextStatus === "inbox")
    ) {
      clearTaskWorkflowState(id);
      if (resetReason) {
        endTaskExecutionSession(id, resetReason);
      }
    }
    if (
      nextStatus &&
      (nextStatus === "pending" ||
        nextStatus === "cancelled" ||
        nextStatus === "done" ||
        nextStatus === "review" ||
        nextStatus === "inbox")
    ) {
      deleteTaskRetryQueueRow(db as any, id);
    }
    if (shouldResetTask) {
      releaseLinkedAgents(id);
    }

    appendTaskLog(id, "system", `Task updated: ${Object.keys(body as object).join(", ")}`);

    const updated = decorateTaskWithDevelopmentHandoff(updatedRow);
    broadcast("task_update", updated);
    res.json({ ok: true, task: updated });
  });

  app.post("/api/tasks/bulk-hide", (req, res) => {
    const { statuses, hidden } = req.body ?? {};
    if (!Array.isArray(statuses) || statuses.length === 0 || (hidden !== 0 && hidden !== 1)) {
      return res.status(400).json({ error: "invalid_body" });
    }
    const placeholders = statuses.map(() => "?").join(",");
    const result = db
      .prepare(`UPDATE tasks SET hidden = ?, updated_at = ? WHERE status IN (${placeholders}) AND hidden != ?`)
      .run(hidden, nowMs(), ...statuses, hidden);
    broadcast("tasks_changed", {});
    res.json({ ok: true, affected: result.changes });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const id = String(req.params.id);
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          assigned_agent_id: string | null;
        }
      | undefined;
    if (!existing) return res.status(404).json({ error: "not_found" });

    stopActiveTaskProcess(id);
    rollbackTaskIfPresent(id, "task_deleted");
    endTaskExecutionSession(id, "task_deleted");
    clearTaskWorkflowState(id);
    releaseLinkedAgents(id);

    db.prepare("DELETE FROM task_logs WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM task_retry_queue WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM task_quality_items WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM task_quality_runs WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM task_artifacts WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM task_run_sheets WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);

    for (const suffix of [".log", ".prompt.txt"]) {
      const filePath = path.join(logsDir, `${id}${suffix}`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // 로그 파일 정리는 베스트 에포트
      }
    }

    broadcast("task_update", { id, deleted: true });
    res.json({ ok: true });
  });
}
