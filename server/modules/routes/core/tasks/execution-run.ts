import fs from "node:fs";
import path from "node:path";
import { notifyTaskStatus } from "../../../../gateway/client.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow } from "../../shared/types.ts";
import { createProjectPathPolicy } from "../projects/path-policy.ts";
import { resolveConstrainedAgentScopeForTask, selectAutoAssignableAgentForTask } from "./execution-run-auto-assign.ts";
import { buildWorkflowPackExecutionGuidance } from "../../../workflow/packs/execution-guidance.ts";
import { buildRuntimeWorkflowPackPromptSections } from "../../../workflow/packs/runtime-effective-pack.ts";
import { resolveVideoArtifactSpecForTask } from "../../../workflow/packs/video-artifact.ts";
import { ensureVideoPreprodRemotionBestPracticesSkill } from "../../../workflow/core/video-skill-bootstrap.ts";
import { getTaskShortId } from "../../../workflow/core/worktree/lifecycle.ts";
import {
  buildInterruptPromptBlock,
  consumeInterruptPrompts,
  loadPendingInterruptPrompts,
} from "../../../workflow/core/interrupt-injection-tools.ts";

export type TaskRunRouteDeps = Pick<
  RuntimeContext,
  | "app"
  | "db"
  | "activeProcesses"
  | "appendTaskLog"
  | "nowMs"
  | "resolveLang"
  | "ensureTaskExecutionSession"
  | "logsDir"
  | "createWorktree"
  | "generateProjectContext"
  | "getRecentChanges"
  | "ensureClaudeMd"
  | "getDeptRoleConstraint"
  | "normalizeTextField"
  | "getRecentConversationContext"
  | "getTaskContinuationContext"
  | "pickL"
  | "l"
  | "getProviderModelConfig"
  | "buildTaskExecutionPrompt"
  | "hasExplicitWarningFixRequest"
  | "getNextHttpAgentPid"
  | "broadcast"
  | "getAgentDisplayName"
  | "notifyCeo"
  | "startProgressTimer"
  | "launchApiProviderAgent"
  | "launchHttpAgent"
  | "spawnCliAgent"
  | "handleTaskRunComplete"
  | "buildAvailableSkillsPromptBlock"
>;

export function registerTaskRunRoute(deps: TaskRunRouteDeps): void {
  const {
    app,
    db,
    activeProcesses,
    appendTaskLog,
    nowMs,
    resolveLang,
    ensureTaskExecutionSession,
    logsDir,
    createWorktree,
    generateProjectContext,
    getRecentChanges,
    ensureClaudeMd,
    getDeptRoleConstraint,
    normalizeTextField,
    getRecentConversationContext,
    getTaskContinuationContext,
    pickL,
    l,
    getProviderModelConfig,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    broadcast,
    getAgentDisplayName,
    notifyCeo,
    startProgressTimer,
    launchApiProviderAgent,
    launchHttpAgent,
    spawnCliAgent,
    handleTaskRunComplete,
    buildAvailableSkillsPromptBlock,
  } = deps;

  const { isRelativeProjectPathInput, normalizeProjectPathInput, isPathInsideAllowedRoots, normalizePathForScopeCompare } =
    createProjectPathPolicy({ normalizeTextField });

  function formatWorktreeCreationFailure(taskLang: string, failureCode?: string): string {
    if (failureCode === "git_bootstrap_disabled") {
      return pickL(
        l(
          [
            "프로젝트 정책상 auto git bootstrap이 비활성화되어 실행을 차단했습니다. 먼저 `git init`, `git add -A`, `git commit -m \"initial commit\"`을 실행한 뒤 다시 시도하세요.",
          ],
          [
            "Execution was blocked because auto git bootstrap is disabled by project policy. Run `git init`, `git add -A`, and `git commit -m \"initial commit\"`, then retry.",
          ],
          [
            "プロジェクトポリシーにより auto git bootstrap が無効なため実行を停止しました。先に `git init`、`git add -A`、`git commit -m \"initial commit\"` を実行してから再試行してください。",
          ],
          [
            "由于项目策略禁用了 auto git bootstrap，执行已被阻止。请先运行 `git init`、`git add -A`、`git commit -m \"initial commit\"`，然后重试。",
          ],
        ),
        taskLang,
      );
    }
    return "Isolated worktree creation failed. Task execution was blocked to protect the project root.";
  }

  function buildProjectPathError(error: string, taskLang: string): { error: string; message: string } {
    const messages = {
      relative_project_path_not_allowed: pickL(
        l(
          ["상대 경로 project path는 허용되지 않습니다. 프로젝트를 다시 연결하거나 절대 경로로 갱신하세요."],
          ["Relative project paths are not allowed. Re-link the project or update the task with an absolute path."],
          ["相対パスの project path は許可されません。プロジェクトを再接続するか、絶対パスへ更新してください。"],
          ["不允许使用相对 project path。请重新关联项目，或将任务路径更新为绝对路径。"],
        ),
        taskLang,
      ),
      project_path_outside_allowed_roots: pickL(
        l(
          ["project path가 허용된 루트 밖에 있습니다. 프로젝트를 다시 연결하거나 승인된 절대 경로로 갱신하세요."],
          ["The project path is outside the allowed roots. Re-link the project or update the task with an approved absolute path."],
          ["project path が許可ルート外です。プロジェクトを再接続するか、承認済みの絶対パスへ更新してください。"],
          ["project path 位于允许根目录之外。请重新关联项目，或更新为受允许的绝对路径。"],
        ),
        taskLang,
      ),
      conflicting_project_path_sources: pickL(
        l(
          ["project 경로 소스가 서로 충돌합니다. project 연결 또는 task path를 정리한 뒤 다시 실행하세요."],
          ["Project path sources conflict. Fix the project binding or task path, then retry the run."],
          ["project path のソースが衝突しています。プロジェクト紐付けまたは task path を修正してから再実行してください。"],
          ["project path 来源互相冲突。请修正项目绑定或任务路径后再重试。"],
        ),
        taskLang,
      ),
      invalid_task_project_path: pickL(
        l(
          ["현재 task의 project path를 실행 경로로 사용할 수 없습니다. 프로젝트를 다시 연결하거나 절대 경로로 수정하세요."],
          ["The task project path cannot be used for execution. Re-link the project or update the task with a valid absolute path."],
          ["現在の task project path は実行に使えません。プロジェクトを再接続するか、有効な絶対パスへ更新してください。"],
          ["当前 task project path 无法用于执行。请重新关联项目，或更新为有效的绝对路径。"],
        ),
        taskLang,
      ),
      missing_project_path: pickL(
        l(
          ["현재 프로젝트 경로가 없어 실행을 시작할 수 없습니다. 기존 프로젝트를 선택하거나 절대 경로를 지정하세요."],
          ["Task execution requires a project path. Select an existing project or provide an absolute path."],
          ["実行にはプロジェクトパスが必要です。既存プロジェクトを選択するか、絶対パスを指定してください。"],
          ["执行需要项目路径。请选择现有项目，或提供绝对路径。"],
        ),
        taskLang,
      ),
    } as const;

    return {
      error,
      message: messages[error as keyof typeof messages] ?? messages.invalid_task_project_path,
    };
  }

  function validateConfiguredPath(raw: unknown): { ok: true; path: string } | { ok: false; status: number; error: string } {
    const normalized = normalizeProjectPathInput(raw);
    if (!normalized) {
      return {
        ok: false,
        status: 400,
        error: isRelativeProjectPathInput(raw) ? "relative_project_path_not_allowed" : "invalid_task_project_path",
      };
    }
    if (!isPathInsideAllowedRoots(normalized)) {
      return { ok: false, status: 403, error: "project_path_outside_allowed_roots" };
    }
    return { ok: true, path: normalized };
  }

  function validateRuntimePath(projectPath: string): { ok: true; path: string } | { ok: false; status: number; error: string } {
    try {
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) {
        return { ok: false, status: 400, error: "invalid_task_project_path" };
      }
    } catch {
      return { ok: false, status: 400, error: "invalid_task_project_path" };
    }

    try {
      const realPath = fs.realpathSync.native?.(projectPath) ?? fs.realpathSync(projectPath);
      if (!isPathInsideAllowedRoots(realPath)) {
        return { ok: false, status: 403, error: "project_path_outside_allowed_roots" };
      }
      return { ok: true, path: realPath };
    } catch {
      return { ok: false, status: 400, error: "invalid_task_project_path" };
    }
  }

  app.post("/api/tasks/:id/run", (req, res) => {
    const id = String(req.params.id);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          id: string;
          title: string;
          description: string | null;
          assigned_agent_id: string | null;
          department_id: string | null;
          project_id: string | null;
          workflow_pack_key: string | null;
          workflow_meta_json: string | null;
          project_path: string | null;
          status: string;
        }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const taskLang = resolveLang(task.description ?? task.title);

    if (activeProcesses.has(id)) {
      const staleChild = activeProcesses.get(id);
      const stalePid = typeof staleChild?.pid === "number" ? staleChild.pid : null;
      let pidIsAlive = false;
      if (stalePid !== null && stalePid > 0) {
        try {
          process.kill(stalePid, 0);
          pidIsAlive = true;
        } catch {
          pidIsAlive = false;
        }
      }
      if (!pidIsAlive) {
        activeProcesses.delete(id);
        appendTaskLog(id, "system", `Cleaned up stale process handle (pid=${stalePid}) on re-run attempt`);
      }
    }

    if (task.status === "in_progress" || task.status === "collaborating") {
      if (activeProcesses.has(id)) {
        return res.status(400).json({ error: "already_running" });
      }
      const t = nowMs();
      db.prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?").run(t, id);
      task.status = "pending";
      appendTaskLog(id, "system", `Reset stale in_progress status (no active process) for re-run`);
    }

    if (activeProcesses.has(id)) {
      return res.status(409).json({
        error: "process_still_active",
        message: "Previous run is still stopping. Please retry after a moment.",
      });
    }

    let agentId = task.assigned_agent_id || (req.body?.agent_id as string | undefined);
    if (agentId) {
      const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
        workflow_pack_key: task.workflow_pack_key,
        department_id: task.department_id,
        project_id: task.project_id,
      });
      if (
        Array.isArray(constrainedAgentIds) &&
        constrainedAgentIds.length > 0 &&
        !constrainedAgentIds.includes(agentId)
      ) {
        appendTaskLog(
          id,
          "system",
          `Assigned agent (${agentId}) is out of scope for workflow pack. Re-selecting by pack rules.`,
        );
        agentId = undefined;
      }
    }
    if (!agentId) {
      const autoSelected = selectAutoAssignableAgentForTask(db as any, {
        workflow_pack_key: task.workflow_pack_key,
        department_id: task.department_id,
        project_id: task.project_id,
      });
      if (autoSelected) {
        agentId = autoSelected.agent.id;
        const assignedAt = nowMs();
        db.prepare(
          "UPDATE tasks SET assigned_agent_id = ?, department_id = COALESCE(department_id, ?), status = CASE WHEN status = 'inbox' THEN 'planned' ELSE status END, updated_at = ? WHERE id = ?",
        ).run(agentId, autoSelected.agent.department_id, assignedAt, id);
        db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(id, agentId);
        appendTaskLog(
          id,
          "system",
          `Auto-assigned by workflow pack (${autoSelected.packKey}): ${autoSelected.agent.name}`,
        );
      }
    }
    if (!agentId) {
      return res.status(400).json({
        error: "no_agent_assigned",
        message: "Assign an agent before running.",
      });
    }

    let agent:
      | {
          id: string;
          name: string;
          name_ko: string | null;
          role: string;
          cli_provider: string | null;
          oauth_account_id: string | null;
          api_provider_id: string | null;
          api_model: string | null;
          cli_model: string | null;
          cli_reasoning_level: string | null;
          personality: string | null;
          department_id: string | null;
          department_name: string | null;
          department_name_ko: string | null;
          department_prompt: string | null;
        }
      | undefined;
    try {
      agent = db
        .prepare(
          `
      SELECT
        a.*,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.name_ko, d.name_ko) AS department_name_ko,
        COALESCE(opd.prompt, d.prompt) AS department_prompt
      FROM agents a
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = COALESCE(?, 'development')
       AND opd.department_id = a.department_id
      LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `,
        )
        .get(task.workflow_pack_key, agentId) as
        | {
            id: string;
            name: string;
            name_ko: string | null;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            personality: string | null;
            department_id: string | null;
            department_name: string | null;
            department_name_ko: string | null;
            department_prompt: string | null;
          }
        | undefined;
    } catch {
      agent = db
        .prepare(
          `
      SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.prompt AS department_prompt
      FROM agents a LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `,
        )
        .get(agentId) as
        | {
            id: string;
            name: string;
            name_ko: string | null;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            personality: string | null;
            department_id: string | null;
            department_name: string | null;
            department_name_ko: string | null;
            department_prompt: string | null;
          }
        | undefined;
    }
    if (!agent) return res.status(400).json({ error: "agent_not_found" });
    const taskShortId = getTaskShortId(id);

    const agentBusy = activeProcesses.has(
      (
        db.prepare("SELECT current_task_id FROM agents WHERE id = ? AND status = 'working'").get(agentId) as
          | { current_task_id: string | null }
          | undefined
      )?.current_task_id ?? "",
    );
    if (agentBusy) {
      return res
        .status(400)
        .json({ error: "agent_busy", message: `${agent.name} is already working on another task.` });
    }

    const provider = agent.cli_provider || "claude";
    if (!["claude", "codex", "gemini", "opencode", "kimi", "copilot", "antigravity", "api"].includes(provider)) {
      return res.status(400).json({ error: "unsupported_provider", provider });
    }
    ensureVideoPreprodRemotionBestPracticesSkill({
      db: db as any,
      nowMs,
      workflowPackKey: task.workflow_pack_key,
      provider,
      taskId: id,
      appendTaskLog,
    });

    const projectRow = task.project_id
      ? (db.prepare("SELECT project_path FROM projects WHERE id = ?").get(task.project_id) as
          | { project_path: string | null }
          | undefined)
      : undefined;
    const resolvedProjectPath = task.project_id ? validateConfiguredPath(projectRow?.project_path) : null;
    if (task.project_id && (!projectRow || !resolvedProjectPath?.ok)) {
      const failure = resolvedProjectPath && !resolvedProjectPath.ok
        ? buildProjectPathError(resolvedProjectPath.error, taskLang)
        : buildProjectPathError("invalid_task_project_path", taskLang);
      return res.status(resolvedProjectPath && !resolvedProjectPath.ok ? resolvedProjectPath.status : 400).json(failure);
    }

    const configuredTaskProjectPath = normalizeTextField(task.project_path);
    const configuredRequestProjectPath = normalizeTextField(req.body?.project_path);
    const taskPathValidation = configuredTaskProjectPath ? validateConfiguredPath(configuredTaskProjectPath) : null;
    const requestPathValidation = configuredRequestProjectPath ? validateConfiguredPath(configuredRequestProjectPath) : null;

    if (taskPathValidation && !taskPathValidation.ok) {
      const failure = buildProjectPathError(taskPathValidation.error, taskLang);
      return res.status(taskPathValidation.status).json(failure);
    }
    if (requestPathValidation && !requestPathValidation.ok) {
      const failure = buildProjectPathError(requestPathValidation.error, taskLang);
      return res.status(requestPathValidation.status).json(failure);
    }

    let configuredProjectPath: string | null = null;
    if (resolvedProjectPath?.ok) {
      configuredProjectPath = resolvedProjectPath.path;
      if (taskPathValidation?.ok && normalizePathForScopeCompare(taskPathValidation.path) !== normalizePathForScopeCompare(configuredProjectPath)) {
        const failure = buildProjectPathError("conflicting_project_path_sources", taskLang);
        return res.status(409).json(failure);
      }
      if (
        requestPathValidation?.ok &&
        normalizePathForScopeCompare(requestPathValidation.path) !== normalizePathForScopeCompare(configuredProjectPath)
      ) {
        const failure = buildProjectPathError("conflicting_project_path_sources", taskLang);
        return res.status(409).json(failure);
      }
    } else if (taskPathValidation?.ok) {
      configuredProjectPath = taskPathValidation.path;
      if (
        requestPathValidation?.ok &&
        normalizePathForScopeCompare(requestPathValidation.path) !== normalizePathForScopeCompare(configuredProjectPath)
      ) {
        const failure = buildProjectPathError("conflicting_project_path_sources", taskLang);
        return res.status(409).json(failure);
      }
    } else if (requestPathValidation?.ok) {
      configuredProjectPath = requestPathValidation.path;
    }

    if (!configuredProjectPath) {
      const failure = buildProjectPathError("missing_project_path", taskLang);
      return res.status(400).json(failure);
    }

    const runtimeProjectPath = validateRuntimePath(configuredProjectPath);
    if (!runtimeProjectPath.ok) {
      const failure = buildProjectPathError(runtimeProjectPath.error, taskLang);
      return res.status(runtimeProjectPath.status).json(failure);
    }
    const projectPath = runtimeProjectPath.path;

    const executionSession = ensureTaskExecutionSession(id, agentId, provider);
    const pendingInterruptPrompts = loadPendingInterruptPrompts(db as any, id, executionSession.sessionId);
    const interruptPromptBlock = buildInterruptPromptBlock(pendingInterruptPrompts);
    const logPath = path.join(logsDir, `${id}.log`);

    const worktreeResult = createWorktree(projectPath, id, agent.name);
    if (!worktreeResult.success) {
      appendTaskLog(
        id,
        "error",
        `Execution blocked: isolated worktree creation failed for project path '${projectPath}' (${worktreeResult.failureCode}: ${worktreeResult.message})`,
      );
      return res.status(409).json({
        error: "worktree_required",
        message: formatWorktreeCreationFailure(taskLang, worktreeResult.failureCode),
      });
    }
    const worktreePath = worktreeResult.worktreePath;
    const agentCwd = worktreePath;

    appendTaskLog(id, "system", `Git worktree created: ${worktreePath} (branch: climpire/${taskShortId})`);

    const projectContext = generateProjectContext(projectPath);
    const recentChanges = getRecentChanges(projectPath, id);

    if (provider === "claude") {
      ensureClaudeMd(projectPath, worktreePath);
    }

    const roleLabel =
      { team_leader: "Team Leader", senior: "Senior", junior: "Junior", intern: "Intern" }[agent.role] || agent.role;
    const deptConstraint = agent.department_id
      ? getDeptRoleConstraint(agent.department_id, agent.department_name || agent.department_id)
      : "";
    const departmentPrompt = normalizeTextField(agent.department_prompt);
    const departmentPromptBlock = departmentPrompt ? `[Department Shared Prompt]\n${departmentPrompt}` : "";
    const conversationCtx = getRecentConversationContext(agentId);
    const continuationCtx = getTaskContinuationContext(id);
    const continuationInstruction = continuationCtx
      ? pickL(
          l(
            ["연속 실행: 동일 소유 컨텍스트를 유지하고, 불필요한 파일 재탐색 없이 미해결 항목만 반영하세요."],
            [
              "Continuation run: keep the same ownership context, avoid re-reading unrelated files, and apply only unresolved deltas.",
            ],
            ["継続実行: 同一オーナーシップを維持し、不要な再探索を避けて未解決差分のみ反映してください。"],
            ["连续执行：保持同一责任上下文，避免重复阅读无关文件，仅处理未解决差异。"],
          ),
          taskLang,
        )
      : pickL(
          l(
            ["반복적인 착수 멘트 없이 바로 실행하세요."],
            ["Execute directly without repeated kickoff narration."],
            ["繰り返しの開始ナレーションなしで直ちに実行してください。"],
            ["无需重复开场说明，直接执行。"],
          ),
          taskLang,
        );
    const projectStructureBlock = continuationCtx
      ? ""
      : projectContext
        ? `[Project Structure]\n${projectContext.length > 4000 ? projectContext.slice(0, 4000) + "\n... (truncated)" : projectContext}`
        : "";
    const needsPlanInstruction = provider === "gemini" || provider === "copilot" || provider === "antigravity";
    const subtaskInstruction = needsPlanInstruction
      ? `\n\n${pickL(
          l(
            [
              `[작업 계획 출력 규칙]
작업을 시작하기 전에 아래 JSON 형식으로 계획을 출력하세요:
\`\`\`json
{"subtasks": [{"title": "서브태스크 제목1"}, {"title": "서브태스크 제목2"}]}
\`\`\`
각 서브태스크를 완료할 때마다 아래 형식으로 보고하세요:
\`\`\`json
{"subtask_done": "완료된 서브태스크 제목"}
\`\`\``,
            ],
            [
              `[Task Plan Output Rules]
Before starting work, print a plan in the JSON format below:
\`\`\`json
{"subtasks": [{"title": "Subtask title 1"}, {"title": "Subtask title 2"}]}
\`\`\`
Whenever you complete a subtask, report it in this format:
\`\`\`json
{"subtask_done": "Completed subtask title"}
\`\`\``,
            ],
            [
              `[作業計画の出力ルール]
作業開始前に、次の JSON 形式で計画を出力してください:
\`\`\`json
{"subtasks": [{"title": "サブタスク1"}, {"title": "サブタスク2"}]}
\`\`\`
各サブタスクを完了するたびに、次の形式で報告してください:
\`\`\`json
{"subtask_done": "完了したサブタスク"}
\`\`\``,
            ],
            [
              `[任务计划输出规则]
开始工作前，请按下述 JSON 格式输出计划:
\`\`\`json
{"subtasks": [{"title": "子任务1"}, {"title": "子任务2"}]}
\`\`\`
每完成一个子任务，请按下述格式汇报:
\`\`\`json
{"subtask_done": "已完成的子任务"}
\`\`\``,
            ],
          ),
          taskLang,
        )}\n`
      : "";

    const modelConfig = getProviderModelConfig();
    const mainModel = agent.cli_model || modelConfig[provider]?.model || undefined;
    const subModel = modelConfig[provider]?.subModel || undefined;
    const mainReasoningLevel =
      provider === "codex"
        ? agent.cli_reasoning_level || modelConfig[provider]?.reasoningLevel || undefined
        : modelConfig[provider]?.reasoningLevel || undefined;
    const subReasoningLevel = modelConfig[provider]?.subModelReasoningLevel || undefined;
    const subModelHint =
      subModel && (provider === "claude" || provider === "codex")
        ? `\n[Sub-agent model preference] When spawning sub-agents (Task tool), prefer using model: ${subModel}${subReasoningLevel ? ` with reasoning effort: ${subReasoningLevel}` : ""}`
        : "";
    const runInstruction = pickL(
      l(
        [
          "위 작업을 충분히 완수하세요. 위 대화 맥락과 프로젝트 구조를 참고해도 좋지만, 프로젝트 구조 탐색에 시간을 쓰지 마세요. 필요한 구조는 이미 제공되었습니다.",
        ],
        [
          "Please complete the task above thoroughly. Use the continuation brief, conversation context, and project structure above if relevant. Do NOT spend time exploring the project structure again unless required by unresolved checklist items.",
        ],
        [
          "上記タスクを丁寧に完了してください。必要に応じて継続要約・会話コンテキスト・プロジェクト構成を参照できますが、未解決チェックリストに必要な場合を除き、構成探索に時間を使わないでください。",
        ],
        [
          "请完整地完成上述任务。可按需参考连续执行摘要、会话上下文和项目结构，但除非未解决清单确有需要，不要再次花时间探索项目结构。",
        ],
      ),
      taskLang,
    );
    const videoArtifactSpec =
      task.workflow_pack_key === "video_preprod"
        ? resolveVideoArtifactSpecForTask(db as any, {
            project_id: task.project_id,
            project_path: task.project_path,
            department_id: task.department_id,
            workflow_pack_key: task.workflow_pack_key,
          })
        : null;
    const workflowPackGuidance = buildWorkflowPackExecutionGuidance(task.workflow_pack_key, taskLang, {
      videoArtifactRelativePath: videoArtifactSpec?.relativePath,
    });
    const workflowPackPromptSections = buildRuntimeWorkflowPackPromptSections({
      db: db as any,
      workflowPackKey: task.workflow_pack_key,
      workflowMetaJson: task.workflow_meta_json,
      workflowPackGuidance,
    });

    const prompt = buildTaskExecutionPrompt(
      [
        (
          buildAvailableSkillsPromptBlock ||
          ((providerName: string) => `[Available Skills][provider=${providerName || "unknown"}][unavailable]`)
        )(provider),
        `[Task Session] id=${executionSession.sessionId} owner=${executionSession.agentId} provider=${executionSession.provider}`,
        "This session is task-scoped. Keep continuity for this task only and do not cross-contaminate context from other projects.",
        projectStructureBlock,
        recentChanges ? `[Recent Changes]\n${recentChanges}` : "",
        `[Task] ${task.title}`,
        task.description ? `\n${task.description}` : "",
        ...workflowPackPromptSections,
        continuationCtx,
        conversationCtx,
        `\n---`,
        `Agent: ${agent.name} (${roleLabel}, ${agent.department_name || "Unassigned"})`,
        agent.personality ? `Personality: ${agent.personality}` : "",
        deptConstraint,
        departmentPromptBlock,
        `NOTE: You are working in an isolated Git worktree branch (climpire/${taskShortId}). Commit your changes normally.`,
        interruptPromptBlock,
        subtaskInstruction,
        subModelHint,
        continuationInstruction,
        runInstruction,
      ],
      {
        allowWarningFix: hasExplicitWarningFixRequest(task.title, task.description),
      },
    );

    if (pendingInterruptPrompts.length > 0) {
      consumeInterruptPrompts(
        db as any,
        pendingInterruptPrompts.map((row) => row.id),
        nowMs(),
      );
      appendTaskLog(
        id,
        "system",
        `INJECT consumed (${pendingInterruptPrompts.length}) for session ${executionSession.sessionId}`,
      );
    }

    appendTaskLog(id, "system", `RUN start (agent=${agent.name}, provider=${provider})`);

    if (provider === "api") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();

      const t = nowMs();
      db.prepare(
        "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
      ).run(agentId, t, t, id);
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
      broadcast("task_update", updatedTask);
      broadcast("agent_status", updatedAgent);
      notifyTaskStatus(id, task.title, "in_progress", taskLang);

      const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
      const worktreeNote = pickL(
        l(
          [` (격리 브랜치: climpire/${taskShortId})`],
          [` (isolated branch: climpire/${taskShortId})`],
          [` (分離ブランチ: climpire/${taskShortId})`],
          [`（隔离分支: climpire/${taskShortId}）`],
        ),
        taskLang,
      );
      notifyCeo(
        pickL(
          l(
            [`${assigneeName}가 '${task.title}' 작업을 시작했습니다.${worktreeNote}`],
            [`${assigneeName} started work on '${task.title}'.${worktreeNote}`],
            [`${assigneeName}が '${task.title}' の作業を開始しました。${worktreeNote}`],
            [`${assigneeName} 已开始处理 '${task.title}'。${worktreeNote}`],
          ),
          taskLang,
        ),
        id,
      );

      const taskRow = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(id) as
        | { department_id: string | null }
        | undefined;
      startProgressTimer(id, task.title, taskRow?.department_id ?? null);

      launchApiProviderAgent(
        id,
        agent.api_provider_id ?? null,
        agent.api_model ?? null,
        prompt,
        agentCwd,
        logPath,
        controller,
        fakePid,
      );
      return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd, worktree: !!worktreePath });
    }

    if (provider === "copilot" || provider === "antigravity") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();

      const t = nowMs();
      db.prepare(
        "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
      ).run(agentId, t, t, id);
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
      broadcast("task_update", updatedTask);
      broadcast("agent_status", updatedAgent);
      notifyTaskStatus(id, task.title, "in_progress", taskLang);

      const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
      const worktreeNote = pickL(
        l(
          [` (격리 브랜치: climpire/${taskShortId})`],
          [` (isolated branch: climpire/${taskShortId})`],
          [` (分離ブランチ: climpire/${taskShortId})`],
          [`（隔离分支: climpire/${taskShortId}）`],
        ),
        taskLang,
      );
      notifyCeo(
        pickL(
          l(
            [`${assigneeName}가 '${task.title}' 작업을 시작했습니다.${worktreeNote}`],
            [`${assigneeName} started work on '${task.title}'.${worktreeNote}`],
            [`${assigneeName}が '${task.title}' の作業を開始しました。${worktreeNote}`],
            [`${assigneeName} 已开始处理 '${task.title}'。${worktreeNote}`],
          ),
          taskLang,
        ),
        id,
      );

      const taskRow = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(id) as
        | { department_id: string | null }
        | undefined;
      startProgressTimer(id, task.title, taskRow?.department_id ?? null);

      launchHttpAgent(id, provider, prompt, agentCwd, logPath, controller, fakePid, agent.oauth_account_id ?? null);
      return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd, worktree: !!worktreePath });
    }

    const child = spawnCliAgent(id, provider, prompt, agentCwd, logPath, mainModel, mainReasoningLevel);

    child.on("close", (code: number | null) => {
      handleTaskRunComplete(id, code ?? 1);
    });

    const t = nowMs();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
    ).run(agentId, t, t, id);
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    broadcast("task_update", updatedTask);
    broadcast("agent_status", updatedAgent);
    notifyTaskStatus(id, task.title, "in_progress", taskLang);

    const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
    const worktreeNote = pickL(
      l(
        [` (격리 브랜치: climpire/${taskShortId})`],
        [` (isolated branch: climpire/${taskShortId})`],
        [` (分離ブランチ: climpire/${taskShortId})`],
        [`（隔离分支: climpire/${taskShortId}）`],
      ),
      taskLang,
    );
    notifyCeo(
      pickL(
        l(
          [`${assigneeName}가 '${task.title}' 작업을 시작했습니다.${worktreeNote}`],
          [`${assigneeName} started work on '${task.title}'.${worktreeNote}`],
          [`${assigneeName}が '${task.title}' の作業を開始しました。${worktreeNote}`],
          [`${assigneeName} 已开始处理 '${task.title}'。${worktreeNote}`],
        ),
        taskLang,
      ),
      id,
    );

    const taskRow = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(id) as
      | { department_id: string | null }
      | undefined;
    startProgressTimer(id, task.title, taskRow?.department_id ?? null);

    res.json({ ok: true, pid: child.pid ?? null, logPath, cwd: agentCwd, worktree: !!worktreePath });
  });
}
