import type { Lang } from "../../../types/lang.ts";
import { resolveConstrainedAgentScopeForTask } from "../../routes/core/tasks/execution-run-auto-assign.ts";

type PlannerSubtaskAssignment = {
  subtask_id: string;
  target_department_id: string | null;
  reason?: string;
  confidence?: number;
};

type DepartmentRow = {
  id: string;
  name: string;
  name_ko: string;
  name_ja?: string | null;
  name_zh?: string | null;
};

type ActiveSubtaskRoutingRow = {
  id: string;
  task_id: string;
  title: string;
  status: string;
  blocked_reason: string | null;
  target_department_id: string | null;
  assigned_agent_id: string | null;
  task_title: string;
  task_description: string | null;
  task_status: string;
  task_department_id: string | null;
  project_id: string | null;
  workflow_pack_key: string | null;
};

type SubtaskRoutingDeps = {
  db: any;
  DEPT_KEYWORDS: Record<string, string[]>;
  detectTargetDepartments: (text: string) => string[];
  runAgentOneShot: (agent: any, prompt: string, options: any) => Promise<{ text: string }>;
  resolveProjectPath: (task: { title?: string; description?: string | null; project_path?: string | null }) => string;
  resolveLang: (text: string) => Lang;
  findTeamLeader: (departmentId: string, candidateAgentIds?: string[] | null) => any;
  getDeptName: (departmentId: string) => string;
  pickL: (choices: any, lang: string) => string;
  l: (ko: string[], en: string[], ja: string[], zh: string[]) => any;
  broadcast: (event: string, payload: unknown) => void;
  appendTaskLog: (taskId: string | null, kind: string, message: string) => void;
  notifyCeo: (message: string, taskId: string | null, messageType?: string) => void;
};

export function createSubtaskRoutingTools(deps: SubtaskRoutingDeps) {
  const {
    db,
    DEPT_KEYWORDS,
    detectTargetDepartments,
    runAgentOneShot,
    resolveLang,
    findTeamLeader,
    getDeptName,
    pickL,
    l,
    broadcast,
    appendTaskLog,
    notifyCeo,
  } = deps;

  const DEPARTMENT_ROLE_HINT_ALIASES: Record<string, string[]> = {
    planning: ["기획팀장", "기획 리드", "기획 담당", "planning lead", "planning owner"],
    dev: ["개발팀장", "개발 리드", "개발 담당", "engineering lead", "engineering owner", "dev lead"],
    design: ["디자인팀장", "디자인 리드", "디자인 담당", "design lead", "design owner"],
    qa: ["qa팀장", "qa 리드", "qa 담당", "품질관리팀장", "품질관리 리드", "품질관리 담당", "qa/qc팀장"],
    devsecops: [
      "인프라보안팀장",
      "인프라보안 리드",
      "인프라보안 담당",
      "인프라팀장",
      "보안팀장",
      "devsecops lead",
      "infra lead",
      "security lead",
    ],
    operations: ["운영팀장", "운영 리드", "운영 담당", "operations lead", "operations owner"],
  };

  function normalizeDepartmentHintToken(input: string): string {
    return input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function getDepartmentRows(): DepartmentRow[] {
    try {
      return db
        .prepare("SELECT id, name, name_ko, name_ja, name_zh FROM departments ORDER BY sort_order ASC")
        .all() as DepartmentRow[];
    } catch {
      try {
        return db.prepare("SELECT id, name, name_ko, name_ja, name_zh FROM departments ORDER BY id ASC").all() as DepartmentRow[];
      } catch {
        return db.prepare("SELECT id, name, name_ko FROM departments ORDER BY id ASC").all() as DepartmentRow[];
      }
    }
  }

  function buildDepartmentAliasTokens(dept: DepartmentRow): string[] {
    const raw = new Set<string>([
      dept.id,
      dept.name,
      dept.name_ko,
      dept.name_ja ?? "",
      dept.name_zh ?? "",
      dept.name_ko.replace(/팀$/g, ""),
      dept.name.replace(/\s*team$/gi, ""),
    ]);
    for (const alias of DEPARTMENT_ROLE_HINT_ALIASES[dept.id] ?? []) {
      raw.add(alias);
    }
    return [...raw]
      .map((value) => normalizeDepartmentHintToken(String(value ?? "").trim()))
      .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);
  }

  function buildDepartmentRoleHintTokens(dept: DepartmentRow): string[] {
    const baseAliases = buildDepartmentAliasTokens(dept);
    const tokens = new Set<string>();
    const suffixes = ["팀장", "리드", "담당", "lead", "owner", "manager"];
    for (const alias of baseAliases) {
      tokens.add(alias);
      const trimmed = alias.replace(/(team|팀|组|組|班)$/u, "");
      for (const base of new Set([alias, trimmed])) {
        if (!base) continue;
        for (const suffix of suffixes) {
          tokens.add(normalizeDepartmentHintToken(`${base}${suffix}`));
        }
      }
    }
    return [...tokens].filter(Boolean);
  }

  function findExplicitDepartmentByMention(text: string, parentDeptId: string | null): string | null {
    const normalized = normalizeDepartmentHintToken(text);
    const deptRows = getDepartmentRows();

    let best: { id: string; index: number; len: number } | null = null;
    for (const dept of deptRows) {
      if (dept.id === parentDeptId) continue;
      for (const token of buildDepartmentAliasTokens(dept)) {
        if (!token) continue;
        const idx = normalized.indexOf(token);
        if (idx < 0) continue;
        if (!best || idx < best.index || (idx === best.index && token.length > best.len)) {
          best = { id: dept.id, index: idx, len: token.length };
        }
      }
    }
    return best?.id ?? null;
  }

  function findExplicitDepartmentRoleHint(text: string, parentDeptId: string | null): string | null {
    const normalized = normalizeDepartmentHintToken(text);
    const deptRows = getDepartmentRows();

    let best: { id: string; index: number; len: number } | null = null;
    for (const dept of deptRows) {
      if (dept.id === parentDeptId) continue;
      for (const token of buildDepartmentRoleHintTokens(dept)) {
        if (!token) continue;
        const idx = normalized.indexOf(token);
        if (idx < 0) continue;
        if (!best || idx < best.index || (idx === best.index && token.length > best.len)) {
          best = { id: dept.id, index: idx, len: token.length };
        }
      }
    }
    return best?.id ?? null;
  }

  function analyzeSubtaskDepartment(subtaskTitle: string, parentDeptId: string | null): string | null {
    const cleaned = subtaskTitle
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return null;

    const explicitRoleHint = findExplicitDepartmentRoleHint(cleaned, parentDeptId);
    if (explicitRoleHint) return explicitRoleHint;

    const prefix = cleaned.includes(":") ? cleaned.split(":")[0] : cleaned;
    const explicitFromPrefix = findExplicitDepartmentByMention(prefix, parentDeptId);
    if (explicitFromPrefix) return explicitFromPrefix;

    const explicitFromWhole = findExplicitDepartmentByMention(cleaned, parentDeptId);
    if (explicitFromWhole) return explicitFromWhole;

    const foreignDepts = detectTargetDepartments(cleaned).filter((d) => d !== parentDeptId);
    if (foreignDepts.length <= 1) return foreignDepts[0] ?? null;

    const normalized = cleaned.toLowerCase();
    let bestDept: string | null = null;
    let bestScore = -1;
    let bestFirstHit = Number.MAX_SAFE_INTEGER;

    for (const deptId of foreignDepts) {
      const keywords = DEPT_KEYWORDS[deptId] ?? [];
      let score = 0;
      let firstHit = Number.MAX_SAFE_INTEGER;
      for (const keyword of keywords) {
        const token = keyword.toLowerCase();
        const idx = normalized.indexOf(token);
        if (idx < 0) continue;
        score += 1;
        if (idx < firstHit) firstHit = idx;
      }
      if (score > bestScore || (score === bestScore && firstHit < bestFirstHit)) {
        bestScore = score;
        bestFirstHit = firstHit;
        bestDept = deptId;
      }
    }

    return bestDept ?? foreignDepts[0] ?? null;
  }

  function repairExplicitRoleSubtaskRouting(): number {
    const rows = db.prepare(
      `
      SELECT
        s.id,
        s.task_id,
        s.title,
        s.status,
        s.blocked_reason,
        s.target_department_id,
        s.assigned_agent_id,
        t.title AS task_title,
        t.description AS task_description,
        t.status AS task_status,
        t.department_id AS task_department_id,
        t.project_id,
        t.workflow_pack_key
      FROM subtasks s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.status IN ('pending', 'blocked')
        AND (s.delegated_task_id IS NULL OR s.delegated_task_id = '')
        AND t.status NOT IN ('done', 'cancelled')
      ORDER BY s.created_at ASC
    `,
    ).all() as ActiveSubtaskRoutingRow[];

    let updated = 0;
    for (const row of rows) {
      const expectedDeptId = findExplicitDepartmentRoleHint(row.title, row.task_department_id ?? null);
      if (!expectedDeptId) continue;

      const lang = resolveLang(row.task_description ?? row.task_title ?? row.title);
      const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
        project_id: row.project_id,
        workflow_pack_key: row.workflow_pack_key,
        department_id: row.task_department_id,
      });
      const targetLeader = findTeamLeader(expectedDeptId, constrainedAgentIds);
      const targetDeptName = getDeptName(expectedDeptId);
      const blockedReason = pickL(
        l(
          [`${targetDeptName} 협업 대기`],
          [`Waiting for ${targetDeptName} collaboration`],
          [`${targetDeptName}の協業待ち`],
          [`等待${targetDeptName}协作`],
        ),
        lang,
      );
      const nextAssignedAgentId = targetLeader?.id ?? row.assigned_agent_id ?? null;

      const targetSame = (row.target_department_id ?? null) === expectedDeptId;
      const statusSame = row.status === "blocked";
      const blockedSame = (row.blocked_reason ?? null) === blockedReason;
      const assigneeSame = (row.assigned_agent_id ?? null) === (nextAssignedAgentId ?? null);
      if (targetSame && statusSame && blockedSame && assigneeSame) continue;

      db.prepare(
        "UPDATE subtasks SET target_department_id = ?, status = 'blocked', blocked_reason = ?, assigned_agent_id = ? WHERE id = ?",
      ).run(expectedDeptId, blockedReason, nextAssignedAgentId, row.id);
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(row.id));
      appendTaskLog(row.task_id, "system", `Repaired explicit-role subtask routing: '${row.title}' => ${expectedDeptId}`);
      updated += 1;
    }

    return updated;
  }

  const plannerSubtaskRoutingInFlight = new Set<string>();

  function normalizeDeptAliasToken(input: string): string {
    return input.toLowerCase().replace(/[\s_\-()[\]{}]/g, "");
  }

  function normalizePlannerTargetDeptId(
    rawTarget: unknown,
    ownerDeptId: string | null,
    deptRows: Array<{ id: string; name: string; name_ko: string }>,
  ): string | null {
    if (rawTarget == null) return null;
    const raw = String(rawTarget).trim();
    if (!raw) return null;
    const token = normalizeDeptAliasToken(raw);
    const nullAliases = new Set([
      "null",
      "none",
      "owner",
      "ownerdept",
      "ownerdepartment",
      "same",
      "sameasowner",
      "자체",
      "내부",
      "동일부서",
      "원부서",
      "없음",
      "无",
      "同部门",
      "同部門",
    ]);
    if (nullAliases.has(token)) return null;

    for (const dept of deptRows) {
      const aliases = new Set<string>(
        [dept.id, dept.name, dept.name_ko, dept.name_ko.replace(/팀$/g, ""), dept.name.replace(/\s*team$/i, "")].map(
          (v) => normalizeDeptAliasToken(v),
        ),
      );
      if (aliases.has(token)) {
        return dept.id === ownerDeptId ? null : dept.id;
      }
    }
    return null;
  }

  function parsePlannerSubtaskAssignments(rawText: string): PlannerSubtaskAssignment[] {
    const text = rawText.trim();
    if (!text) return [];

    const candidates: string[] = [];
    const fencedMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (const m of fencedMatches) {
      const body = (m[1] ?? "").trim();
      if (body) candidates.push(body);
    }
    candidates.push(text);
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch?.[0]) candidates.push(objectMatch[0]);

    for (const candidate of candidates) {
      let parsed: any;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      const rows = Array.isArray(parsed?.assignments) ? parsed.assignments : Array.isArray(parsed) ? parsed : [];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const normalized: PlannerSubtaskAssignment[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const subtaskId = typeof row.subtask_id === "string" ? row.subtask_id.trim() : "";
        if (!subtaskId) continue;
        const targetRaw =
          row.target_department_id ?? row.target_department ?? row.department_id ?? row.department ?? null;
        const reason = typeof row.reason === "string" ? row.reason.trim() : undefined;
        const confidence = typeof row.confidence === "number" ? Math.max(0, Math.min(1, row.confidence)) : undefined;
        normalized.push({
          subtask_id: subtaskId,
          target_department_id: targetRaw == null ? null : String(targetRaw),
          reason,
          confidence,
        });
      }
      if (normalized.length > 0) return normalized;
    }

    return [];
  }

  async function rerouteSubtasksByPlanningLeader(
    taskId: string,
    ownerDeptId: string | null,
    phase: "planned" | "review",
  ): Promise<void> {
    const lockKey = `${phase}:${taskId}`;
    if (plannerSubtaskRoutingInFlight.has(lockKey)) return;
    plannerSubtaskRoutingInFlight.add(lockKey);

    try {
      const task = db
        .prepare(
          "SELECT title, description, project_path, assigned_agent_id, department_id, project_id, workflow_pack_key FROM tasks WHERE id = ?",
        )
        .get(taskId) as
        | {
            title: string;
            description: string | null;
            project_path: string | null;
            assigned_agent_id: string | null;
            department_id: string | null;
            project_id: string | null;
            workflow_pack_key: string | null;
          }
        | undefined;
      if (!task) return;
      const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
        project_id: task.project_id,
        workflow_pack_key: task.workflow_pack_key,
        department_id: task.department_id ?? ownerDeptId,
      });
      const planningLeader = findTeamLeader("planning", constrainedAgentIds);
      if (!planningLeader) return;

      const baseDeptId = ownerDeptId ?? task.department_id;
      const lang = resolveLang(task.description ?? task.title);
      const subtasks = db
        .prepare(
          `
      SELECT id, title, description, status, blocked_reason, target_department_id, assigned_agent_id, delegated_task_id
      FROM subtasks
      WHERE task_id = ?
        AND status IN ('pending', 'blocked')
        AND (delegated_task_id IS NULL OR delegated_task_id = '')
      ORDER BY created_at ASC
    `,
        )
        .all(taskId) as Array<{
        id: string;
        title: string;
        description: string | null;
        status: string;
        blocked_reason: string | null;
        target_department_id: string | null;
        assigned_agent_id: string | null;
        delegated_task_id: string | null;
      }>;
      if (subtasks.length === 0) return;

      const deptRows = db.prepare("SELECT id, name, name_ko FROM departments ORDER BY sort_order ASC").all() as Array<{
        id: string;
        name: string;
        name_ko: string;
      }>;
      if (deptRows.length === 0) return;

      const deptGuide = deptRows.map((dept) => `- ${dept.id}: ${dept.name_ko || dept.name} (${dept.name})`).join("\n");
      const subtaskGuide = subtasks
        .map((st, idx) => {
          const compactDesc = (st.description ?? "").replace(/\s+/g, " ").trim();
          const descPart = compactDesc ? ` desc="${compactDesc.slice(0, 220)}"` : "";
          const targetPart = st.target_department_id ? ` current_target=${st.target_department_id}` : "";
          return `${idx + 1}. id=${st.id} title="${st.title}"${descPart}${targetPart}`;
        })
        .join("\n");

      const reroutePrompt = [
        "You are the planning team leader responsible for precise subtask department assignment.",
        "Decide the target department for each subtask.",
        "",
        `Task: ${task.title}`,
        task.description ? `Task description: ${task.description}` : "",
        `Owner department id: ${baseDeptId ?? "unknown"}`,
        `Workflow phase: ${phase}`,
        "",
        "Valid departments:",
        deptGuide,
        "",
        "Subtasks:",
        subtaskGuide,
        "",
        "Return ONLY JSON in this exact shape:",
        '{"assignments":[{"subtask_id":"...","target_department_id":"department_id_or_null","reason":"short reason","confidence":0.0}]}',
        "Rules:",
        "- Include one assignment per listed subtask_id.",
        "- If subtask stays in owner department, set target_department_id to null.",
        "- Do not invent subtask IDs or department IDs.",
        "- confidence must be between 0.0 and 1.0.",
      ]
        .filter(Boolean)
        .join("\n");

      const explicitProjectPath = String(task.project_path ?? "").trim();
      if (!explicitProjectPath) {
        appendTaskLog(taskId, "system", `Planning reroute skipped: missing project path (${phase})`);
        return;
      }

      const run = await runAgentOneShot(planningLeader, reroutePrompt, {
        projectPath: explicitProjectPath,
        timeoutMs: 180_000,
        rawOutput: true,
        noTools: true,
      });
      const assignments = parsePlannerSubtaskAssignments(run.text);
      if (assignments.length === 0) {
        appendTaskLog(taskId, "system", `Planning reroute skipped: parser found no assignment payload (${phase})`);
        return;
      }

      const subtaskById = new Map(subtasks.map((st) => [st.id, st]));
      const summaryByDept = new Map<string, number>();
      let updated = 0;

      for (const assignment of assignments) {
        const subtask = subtaskById.get(assignment.subtask_id);
        if (!subtask) continue;

        const normalizedTargetDept = normalizePlannerTargetDeptId(
          assignment.target_department_id,
          baseDeptId,
          deptRows,
        );

        let nextStatus = subtask.status;
        let nextBlockedReason = subtask.blocked_reason ?? null;
        let nextAssignee = subtask.assigned_agent_id ?? null;
        if (normalizedTargetDept) {
          const targetDeptName = getDeptName(normalizedTargetDept);
          const targetLeader = findTeamLeader(normalizedTargetDept, constrainedAgentIds);
          nextStatus = "blocked";
          nextBlockedReason = pickL(
            l(
              [`${targetDeptName} 협업 대기`],
              [`Waiting for ${targetDeptName} collaboration`],
              [`${targetDeptName}の協業待ち`],
              [`等待${targetDeptName}协作`],
            ),
            lang,
          );
          if (targetLeader) nextAssignee = targetLeader.id;
        } else {
          if (subtask.status === "blocked") nextStatus = "pending";
          nextBlockedReason = null;
          if (task.assigned_agent_id) nextAssignee = task.assigned_agent_id;
        }

        const targetSame = (subtask.target_department_id ?? null) === normalizedTargetDept;
        const statusSame = subtask.status === nextStatus;
        const blockedSame = (subtask.blocked_reason ?? null) === (nextBlockedReason ?? null);
        const assigneeSame = (subtask.assigned_agent_id ?? null) === (nextAssignee ?? null);
        if (targetSame && statusSame && blockedSame && assigneeSame) continue;

        db.prepare(
          "UPDATE subtasks SET target_department_id = ?, status = ?, blocked_reason = ?, assigned_agent_id = ? WHERE id = ?",
        ).run(normalizedTargetDept, nextStatus, nextBlockedReason, nextAssignee, subtask.id);
        broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtask.id));

        updated++;
        const bucket = normalizedTargetDept ?? baseDeptId ?? "owner";
        summaryByDept.set(bucket, (summaryByDept.get(bucket) ?? 0) + 1);
      }

      if (updated > 0) {
        const summaryText = [...summaryByDept.entries()].map(([deptId, cnt]) => `${deptId}:${cnt}`).join(", ");
        appendTaskLog(taskId, "system", `Planning leader rerouted ${updated} subtasks (${phase}) => ${summaryText}`);
        notifyCeo(
          pickL(
            l(
              [
                `'${task.title}' 서브태스크 분배를 기획팀장이 재판정하여 ${updated}건을 재배치했습니다. (${summaryText})`,
              ],
              [`Planning leader rerouted ${updated} subtasks for '${task.title}'. (${summaryText})`],
              [
                `'${task.title}' のサブタスク配分を企画リーダーが再判定し、${updated}件を再配置しました。（${summaryText}）`,
              ],
              [`规划负责人已重新判定'${task.title}'的子任务分配，并重分配了${updated}项。（${summaryText}）`],
            ),
            lang,
          ),
          taskId,
        );
      }
    } catch (err: any) {
      appendTaskLog(
        taskId,
        "system",
        `Planning reroute failed (${phase}): ${err?.message ? String(err.message) : String(err)}`,
      );
    } finally {
      plannerSubtaskRoutingInFlight.delete(lockKey);
    }
  }

  return {
    analyzeSubtaskDepartment,
    repairExplicitRoleSubtaskRouting,
    rerouteSubtasksByPlanningLeader,
  };
}
