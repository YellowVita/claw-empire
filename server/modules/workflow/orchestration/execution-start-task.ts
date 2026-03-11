import path from "node:path";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { getDepartmentPromptForPack } from "../packs/department-scope.ts";
import { ensureVideoPreprodRemotionBestPracticesSkill } from "../core/video-skill-bootstrap.ts";
import { buildWorkflowPackExecutionGuidance } from "../packs/execution-guidance.ts";
import { readProjectWorkflowConfig } from "../packs/project-config.ts";
import { buildRuntimeWorkflowPackPromptSections } from "../packs/runtime-effective-pack.ts";
import { resolveVideoArtifactSpecForTask } from "../packs/video-artifact.ts";
import { getTaskShortId } from "../core/worktree/lifecycle.ts";
import {
  buildInterruptPromptBlock,
  consumeInterruptPrompts,
  loadPendingInterruptPrompts,
} from "../core/interrupt-injection-tools.ts";
import { deleteTaskRetryQueueRow, runTaskExecutionHooks } from "./task-execution-policy.ts";

type CreateExecutionStartTaskToolsDeps = {
  nowMs: RuntimeContext["nowMs"];
  db: RuntimeContext["db"];
  logsDir: RuntimeContext["logsDir"];
  appendTaskLog: RuntimeContext["appendTaskLog"];
  broadcast: RuntimeContext["broadcast"];
  ensureTaskExecutionSession: RuntimeContext["ensureTaskExecutionSession"];
  resolveLang: RuntimeContext["resolveLang"];
  notifyTaskStatus: (...args: any[]) => any;
  createWorktree: RuntimeContext["createWorktree"];
  cleanupWorktree: RuntimeContext["cleanupWorktree"];
  getDeptRoleConstraint: RuntimeContext["getDeptRoleConstraint"];
  getRecentConversationContext: RuntimeContext["getRecentConversationContext"];
  getTaskContinuationContext: RuntimeContext["getTaskContinuationContext"];
  getRecentChanges: RuntimeContext["getRecentChanges"];
  ensureClaudeMd: RuntimeContext["ensureClaudeMd"];
  pickL: RuntimeContext["pickL"];
  l: RuntimeContext["l"];
  buildAvailableSkillsPromptBlock: RuntimeContext["buildAvailableSkillsPromptBlock"];
  buildTaskExecutionPrompt: RuntimeContext["buildTaskExecutionPrompt"];
  hasExplicitWarningFixRequest: RuntimeContext["hasExplicitWarningFixRequest"];
  getNextHttpAgentPid: RuntimeContext["getNextHttpAgentPid"];
  launchApiProviderAgent: RuntimeContext["launchApiProviderAgent"];
  launchHttpAgent: RuntimeContext["launchHttpAgent"];
  getProviderModelConfig: RuntimeContext["getProviderModelConfig"];
  spawnCliAgent: RuntimeContext["spawnCliAgent"];
  handleTaskRunComplete: RuntimeContext["handleTaskRunComplete"];
  notifyCeo: RuntimeContext["notifyCeo"];
  startProgressTimer: RuntimeContext["startProgressTimer"];
};

export function createExecutionStartTaskTools(deps: CreateExecutionStartTaskToolsDeps) {
  const {
    nowMs,
    db,
    logsDir,
    appendTaskLog,
    broadcast,
    ensureTaskExecutionSession,
    resolveLang,
    notifyTaskStatus,
    createWorktree,
    cleanupWorktree,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getTaskContinuationContext,
    getRecentChanges,
    ensureClaudeMd,
    pickL,
    l,
    buildAvailableSkillsPromptBlock,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    getProviderModelConfig,
    spawnCliAgent,
    handleTaskRunComplete,
    notifyCeo,
    startProgressTimer,
  } = deps;

  async function startTaskExecutionForAgent(
    taskId: string,
    execAgent: any,
    deptId: string | null,
    deptName: string,
  ): Promise<void> {
    const execName = execAgent.name_ko || execAgent.name;
    const t = nowMs();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
    ).run(execAgent.id, t, t, taskId);
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(taskId, execAgent.id);
    appendTaskLog(taskId, "system", `${execName} started (approved)`);

    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));

    const provider = execAgent.cli_provider || "claude";
    if (!["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api"].includes(provider)) return;
    const executionSession = ensureTaskExecutionSession(taskId, execAgent.id, provider);
    const pendingInterruptPrompts = loadPendingInterruptPrompts(db as any, taskId, executionSession.sessionId);
    const interruptPromptBlock = buildInterruptPromptBlock(pendingInterruptPrompts);

    const taskData = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          title: string;
          description: string | null;
          project_id: string | null;
          project_path: string | null;
          department_id: string | null;
          base_branch: string | null;
          workflow_pack_key: string | null;
          workflow_meta_json: string | null;
        }
      | undefined;
    if (!taskData) return;
    const taskShortId = getTaskShortId(taskId);
    ensureVideoPreprodRemotionBestPracticesSkill({
      db: db as any,
      nowMs,
      workflowPackKey: taskData.workflow_pack_key,
      provider,
      taskId,
      appendTaskLog,
    });
    const taskLang = resolveLang(taskData.description ?? taskData.title);
    const projectPath = taskData.project_path?.trim() || null;
    if (!projectPath) {
      const rollbackAt = nowMs();
      appendTaskLog(taskId, "error", "Execution blocked: missing project path");
      db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ?").run(
        rollbackAt,
        taskId,
      );
      deleteTaskRetryQueueRow(db as any, taskId);
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = CASE WHEN current_task_id = ? THEN NULL ELSE current_task_id END WHERE id = ?",
      ).run(taskId, execAgent.id);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));
      notifyTaskStatus(taskId, taskData.title, "pending", taskLang);
      notifyCeo(
        pickL(
          l(
            ["[PROJECT PATH REQUIRED] 현재 프로젝트 경로가 없어 실행을 시작하지 않았습니다. 기존 프로젝트를 선택하거나 절대 경로를 지정해야 합니다."],
            ["[PROJECT PATH REQUIRED] Execution was not started because there is no current project path. Select an existing project or provide an absolute path."],
            ["[PROJECT PATH REQUIRED] 現在のプロジェクトパスがないため実行を開始しませんでした。既存プロジェクトを選択するか、絶対パスを指定してください。"],
            ["[PROJECT PATH REQUIRED] 由于当前没有项目路径，执行未启动。请选择现有项目，或提供绝对路径。"],
          ),
          taskLang,
        ),
        taskId,
      );
      return;
    }
    const videoArtifactSpec =
      taskData.workflow_pack_key === "video_preprod"
        ? resolveVideoArtifactSpecForTask(db as any, {
            project_id: taskData.project_id,
            project_path: taskData.project_path,
            department_id: deptId ?? taskData.department_id ?? null,
            workflow_pack_key: taskData.workflow_pack_key,
          })
        : null;
    const workflowPackGuidance = buildWorkflowPackExecutionGuidance(taskData.workflow_pack_key, taskLang, {
      videoArtifactRelativePath: videoArtifactSpec?.relativePath,
    });
    notifyTaskStatus(taskId, taskData.title, "in_progress", taskLang);

    const projPath = projectPath;
    const worktreePath = createWorktree(projPath, taskId, execAgent.name, taskData.base_branch ?? undefined);
    if (!worktreePath) {
      const rollbackAt = nowMs();
      appendTaskLog(
        taskId,
        "error",
        `Execution blocked: isolated worktree creation failed for project path '${projPath}'`,
      );
      db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ?").run(
        rollbackAt,
        taskId,
      );
      deleteTaskRetryQueueRow(db as any, taskId);
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = CASE WHEN current_task_id = ? THEN NULL ELSE current_task_id END WHERE id = ?",
      ).run(taskId, execAgent.id);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));
      notifyTaskStatus(taskId, taskData.title, "pending", taskLang);
      notifyCeo(
        pickL(
          l(
            [
              `[WORKTREE REQUIRED] '${taskData.title}' 실행을 차단했습니다. 격리 worktree 생성에 실패해 프로젝트 루트 오염을 방지하기 위해 중단되었습니다.`,
            ],
            [
              `[WORKTREE REQUIRED] Blocked execution for '${taskData.title}'. Isolated worktree creation failed, so run was aborted to protect the project root.`,
            ],
            [
              `[WORKTREE REQUIRED] '${taskData.title}' の実行を停止しました。分離 worktree 作成に失敗したため、プロジェクトルート保護のため中断しました。`,
            ],
            [
              `[WORKTREE REQUIRED] 已阻止 '${taskData.title}' 的执行。由于隔离 worktree 创建失败，为保护项目根目录已中止。`,
            ],
          ),
          taskLang,
        ),
        taskId,
      );
      return;
    }
    const agentCwd = worktreePath;
    appendTaskLog(taskId, "system", `Git worktree created: ${worktreePath} (branch: climpire/${taskShortId})`);
    const beforeRunResult = await runTaskExecutionHooks({
      db: db as any,
      stage: "before_run",
      taskId,
      taskTitle: taskData.title,
      projectPath: projPath,
      worktreePath,
      agentId: execAgent.id,
      provider,
      appendTaskLog,
    });
    if (!beforeRunResult.ok) {
      const rollbackAt = nowMs();
      db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ?").run(
        rollbackAt,
        taskId,
      );
      deleteTaskRetryQueueRow(db as any, taskId);
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = CASE WHEN current_task_id = ? THEN NULL ELSE current_task_id END WHERE id = ?",
      ).run(taskId, execAgent.id);
      cleanupWorktree(projPath, taskId);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));
      notifyTaskStatus(taskId, taskData.title, "pending", taskLang);
      notifyCeo(
        pickL(
          l(
            [`'${taskData.title}' 실행이 before_run hook 실패로 중단되어 pending으로 되돌렸습니다.`],
            [`Execution for '${taskData.title}' was blocked by a failing before_run hook and moved back to pending.`],
            [`'${taskData.title}' の実行は before_run hook 失敗で中断され、pending に戻しました。`],
            [`'${taskData.title}' 的执行因 before_run hook 失败而中止，并已退回 pending。`],
          ),
          taskLang,
        ),
        taskId,
      );
      return;
    }
    const logFilePath = path.join(logsDir, `${taskId}.log`);
    const roleLabels: Record<string, string> = {
      team_leader: "Team Leader",
      senior: "Senior",
      junior: "Junior",
      intern: "Intern",
    };
    const roleLabel = roleLabels[execAgent.role] ?? execAgent.role;
    const deptConstraint = deptId ? getDeptRoleConstraint(deptId, deptName) : "";
    const deptPromptRaw = deptId ? getDepartmentPromptForPack(db as any, taskData.workflow_pack_key, deptId) : null;
    const deptPrompt = typeof deptPromptRaw === "string" ? deptPromptRaw.trim() : "";
    const deptPromptBlock = deptPrompt ? `[Department Shared Prompt]\n${deptPrompt}` : "";
    const projectWorkflowConfig = readProjectWorkflowConfig(worktreePath);
    const workflowPackPromptSections = buildRuntimeWorkflowPackPromptSections({
      db: db as any,
      workflowPackKey: taskData.workflow_pack_key,
      workflowMetaJson: taskData.workflow_meta_json,
      workflowPackGuidance,
      projectWorkflowPolicyMarkdown: projectWorkflowConfig?.policyMarkdown ?? null,
    });
    const conversationCtx = getRecentConversationContext(execAgent.id);
    const continuationCtx = getTaskContinuationContext(taskId);
    const recentChanges = getRecentChanges(projPath, taskId);
    if (provider === "claude") {
      ensureClaudeMd(projPath, worktreePath);
    }
    const continuationInstruction = continuationCtx
      ? pickL(
          l(
            ["연속 실행: 소유 컨텍스트를 유지하고 인사/착수 멘트 없이 미해결 검토 항목을 즉시 반영하세요."],
            [
              "Continuation run: keep ownership, skip greetings/kickoff narration, and execute unresolved review items immediately.",
            ],
            ["継続実行: オーナーシップを維持し、挨拶/開始ナレーションなしで未解決レビュー項目を即時反映してください。"],
            ["连续执行：保持责任上下文，跳过问候/开场说明，立即处理未解决评审项。"],
          ),
          taskLang,
        )
      : pickL(
          l(
            ["긴 서론 없이 바로 실행하고, 메시지는 간결하게 유지하세요."],
            ["Execute directly without long preamble and keep messages concise."],
            ["長い前置きなしで直ちに実行し、メッセージは簡潔にしてください。"],
            ["无需冗长前言，直接执行并保持消息简洁。"],
          ),
          taskLang,
        );
    const runInstruction = pickL(
      l(
        ["위 작업을 충분히 완수하세요. 필요 시 연속 실행 요약과 대화 맥락을 참고하세요."],
        [
          "Please complete the task above thoroughly. Use the continuation brief and conversation context above if relevant.",
        ],
        ["上記タスクを丁寧に完了してください。必要に応じて継続要約と会話コンテキストを参照してください。"],
        ["请完整地完成上述任务。可按需参考连续执行摘要与会话上下文。"],
      ),
      taskLang,
    );
    const availableSkillsPromptBlock = buildAvailableSkillsPromptBlock(provider);
    const spawnPrompt = buildTaskExecutionPrompt(
      [
        availableSkillsPromptBlock,
        `[Task Session] id=${executionSession.sessionId} owner=${executionSession.agentId} provider=${executionSession.provider}`,
        "This session is scoped to this task only. Keep context continuity inside this task session and do not mix with other projects.",
        recentChanges ? `[Recent Changes]\n${recentChanges}` : "",
        `[Task] ${taskData.title}`,
        taskData.description ? `\n${taskData.description}` : "",
        ...workflowPackPromptSections,
        continuationCtx,
        conversationCtx,
        `\n---`,
        `Agent: ${execAgent.name} (${roleLabel}, ${deptName})`,
        execAgent.personality ? `Personality: ${execAgent.personality}` : "",
        deptConstraint,
        deptPromptBlock,
        `NOTE: You are working in an isolated Git worktree branch (climpire/${taskShortId}). Commit your changes normally.`,
        interruptPromptBlock,
        continuationInstruction,
        runInstruction,
      ],
      {
        allowWarningFix: hasExplicitWarningFixRequest(taskData.title, taskData.description),
      },
    );

    if (pendingInterruptPrompts.length > 0) {
      consumeInterruptPrompts(
        db as any,
        pendingInterruptPrompts.map((row) => row.id),
        nowMs(),
      );
      appendTaskLog(
        taskId,
        "system",
        `INJECT consumed (${pendingInterruptPrompts.length}) for session ${executionSession.sessionId}`,
      );
    }

    appendTaskLog(taskId, "system", `RUN start (agent=${execAgent.name}, provider=${provider})`);
    if (provider === "api") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      launchApiProviderAgent(
        taskId,
        execAgent.api_provider_id ?? null,
        execAgent.api_model ?? null,
        spawnPrompt,
        agentCwd,
        logFilePath,
        controller,
        fakePid,
      );
    } else if (provider === "copilot" || provider === "antigravity") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      launchHttpAgent(
        taskId,
        provider,
        spawnPrompt,
        agentCwd,
        logFilePath,
        controller,
        fakePid,
        execAgent.oauth_account_id ?? null,
      );
    } else {
      const modelConfig = getProviderModelConfig();
      const modelForProvider = execAgent.cli_model || modelConfig[provider]?.model || undefined;
      const reasoningLevel =
        provider === "codex"
          ? execAgent.cli_reasoning_level || modelConfig[provider]?.reasoningLevel || undefined
          : modelConfig[provider]?.reasoningLevel || undefined;
      const child = spawnCliAgent(
        taskId,
        provider,
        spawnPrompt,
        agentCwd,
        logFilePath,
        modelForProvider,
        reasoningLevel,
      );
      child.on("close", (code: number | null) => {
        handleTaskRunComplete(taskId, code ?? 1);
      });
    }

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
          [`${execName}가 '${taskData.title}' 작업을 시작했습니다.${worktreeNote}`],
          [`${execName} started work on '${taskData.title}'.${worktreeNote}`],
          [`${execName}が '${taskData.title}' の作業を開始しました。${worktreeNote}`],
          [`${execName} 已开始处理 '${taskData.title}'。${worktreeNote}`],
        ),
        taskLang,
      ),
      taskId,
    );
    startProgressTimer(taskId, taskData.title, deptId);
  }

  return {
    startTaskExecutionForAgent,
  };
}
