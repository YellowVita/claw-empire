import type { DelegationOptions } from "./project-resolution.ts";
import {
  detectProjectKindChoice,
  isCancelReply,
  isProjectProgressInquiry,
  shouldTreatDirectChatAsTask,
} from "./direct-chat-intent-utils.ts";
import {
  RECENT_EXISTING_PROJECT_LIMIT,
  createProjectBindingFromNameAndPath,
  extractAbsolutePathFromText,
  formatExistingProjectCandidateLines,
  hasProjectBinding,
  inferProjectKindWithModel,
  loadRecentExistingProjects,
  normalizeNewProjectNameInput,
  resolveProjectBindingFromText,
  selectExistingProjectFromCandidates,
} from "./direct-chat-project-binding.ts";
import { sendProjectProgressReply } from "./direct-chat-progress-summary.ts";
import { createDirectReplyRuntime } from "./direct-chat-runtime-reply.ts";
import { createDirectTaskFlow } from "./direct-chat-task-flow.ts";
import type { AgentRow, DirectChatDeps, PendingProjectBinding } from "./direct-chat-types.ts";
import { hydrateOfficePackAgentFromSettings } from "./office-pack-agent-hydration.ts";

export function createDirectChatHandlers(deps: DirectChatDeps) {
  const {
    db,
    nowMs,
    resolveLang,
    detectProjectPath,
    normalizeTextField,
    resolveProjectFromOptions,
    l,
    pickL,
    sendAgentMessage,
    buildCliFailureMessage,
    runAgentOneShot,
  } = deps;

  const pendingProjectBindingByAgent = new Map<string, PendingProjectBinding>();
  const replyRuntime = createDirectReplyRuntime(deps);
  const taskFlow = createDirectTaskFlow({
    ...deps,
    sendInCharacterAutoMessage: replyRuntime.sendInCharacterAutoMessage,
  });

  function mergePendingOptions(base: DelegationOptions, incoming: DelegationOptions): DelegationOptions {
    return {
      ...base,
      messengerChannel: incoming.messengerChannel ?? base.messengerChannel,
      messengerTargetId: incoming.messengerTargetId ?? base.messengerTargetId,
      messengerSessionKey: incoming.messengerSessionKey ?? base.messengerSessionKey,
    };
  }

  function scheduleAgentReply(
    agentId: string,
    ceoMessage: string,
    messageType: string,
    options: DelegationOptions = {},
  ): void {
    const agent =
      (db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined) ??
      hydrateOfficePackAgentFromSettings(db, agentId, nowMs);
    if (!agent) return;

    if (agent.status === "offline") {
      const lang = resolveLang(ceoMessage);
      const offlineMessage = buildCliFailureMessage(agent, lang, "offline");
      sendAgentMessage(agent, offlineMessage);
      void replyRuntime.relayReplyToMessenger(options, agent, offlineMessage).catch((err) => {
        console.warn(`[messenger-reply] failed to relay offline message from ${agent.name}: ${String(err)}`);
      });
      return;
    }

    const now = nowMs();
    const pendingBinding = pendingProjectBindingByAgent.get(agent.id);
    if (pendingBinding) {
      if (now - pendingBinding.requestedAt > 60 * 60 * 1000) {
        pendingProjectBindingByAgent.delete(agent.id);
      } else {
        const lang = resolveLang(ceoMessage);
        const relayOptions = mergePendingOptions(pendingBinding.options, options);
        if (isCancelReply(ceoMessage)) {
          pendingProjectBindingByAgent.delete(agent.id);
          const cancelMsg = pickL(
            l(
              ["알겠습니다. 프로젝트 지정 대기는 취소했습니다."],
              ["Understood. I canceled the pending project binding request."],
              ["承知しました。プロジェクト指定待ちはキャンセルしました。"],
              ["已了解。已取消项目绑定等待。"],
            ),
            lang,
          );
          sendAgentMessage(agent, cancelMsg);
          void replyRuntime.relayReplyToMessenger(relayOptions, agent, cancelMsg).catch((err) => {
            console.warn(`[messenger-reply] failed to relay pending-cancel message from ${agent.name}: ${String(err)}`);
          });
          return;
        }

        if (pendingBinding.state === "ask_kind") {
          const promptExistingSelection = (binding: PendingProjectBinding): void => {
            const recentCandidates = loadRecentExistingProjects(
              {
                db,
                normalizeTextField,
              },
              RECENT_EXISTING_PROJECT_LIMIT,
            );
            const recentLines = formatExistingProjectCandidateLines(normalizeTextField, recentCandidates, lang);
            pendingProjectBindingByAgent.set(agent.id, {
              ...binding,
              state: "ask_existing",
              requestedAt: nowMs(),
              existingCandidates: recentCandidates,
            });
            const askExisting = pickL(
              l(
                [
                  recentLines.length > 0
                    ? `기존 프로젝트를 선택해주세요. 최근 프로젝트 ${RECENT_EXISTING_PROJECT_LIMIT}개입니다.\n${recentLines.join("\n")}\n번호(1-${recentLines.length}) 또는 프로젝트 이름/절대경로를 보내주세요.`
                    : "기존 프로젝트 목록이 비어 있습니다. 프로젝트 절대경로(예: /Users/classys/Projects/climpire) 또는 기존 프로젝트 이름을 보내주세요.",
                ],
                [
                  recentLines.length > 0
                    ? `Choose an existing project. Recent ${RECENT_EXISTING_PROJECT_LIMIT} projects:\n${recentLines.join("\n")}\nSend a number (1-${recentLines.length}) or project name/absolute path.`
                    : "No recent existing projects found. Send an absolute project path (e.g. /Users/classys/Projects/climpire) or an existing project name.",
                ],
                [
                  recentLines.length > 0
                    ? `既存プロジェクトを選んでください。最近の${RECENT_EXISTING_PROJECT_LIMIT}件です:\n${recentLines.join("\n")}\n番号(1-${recentLines.length}) またはプロジェクト名/絶対パスを送ってください。`
                    : "既存プロジェクト一覧がありません。絶対パスまたは既存プロジェクト名を送ってください。",
                ],
                [
                  recentLines.length > 0
                    ? `请选择已有项目。最近${RECENT_EXISTING_PROJECT_LIMIT}个项目如下：\n${recentLines.join("\n")}\n请发送编号(1-${recentLines.length})，或项目名称/绝对路径。`
                    : "当前没有最近项目列表。请发送项目绝对路径或已有项目名称。",
                ],
              ),
              lang,
            );
            replyRuntime.sendInCharacterAutoMessage({
              agent,
              lang,
              scenario:
                "You need the user to choose an existing project from a recent list. The user can answer with number, project name, or absolute path.",
              fallback: askExisting,
              options: relayOptions,
              strictFallback: true,
            });
          };

          const promptNewProjectName = (binding: PendingProjectBinding): void => {
            pendingProjectBindingByAgent.set(agent.id, {
              ...binding,
              state: "ask_new_name",
              requestedAt: nowMs(),
            });
            const askNewName = pickL(
              l(
                ["신규 프로젝트 이름을 먼저 알려주세요."],
                ["Please provide the new project name first."],
                ["新規プロジェクト名を先に教えてください。"],
                ["请先提供新项目名称。"],
              ),
              lang,
            );
            replyRuntime.sendInCharacterAutoMessage({
              agent,
              lang,
              scenario: "You need the new project name before continuing task escalation.",
              fallback: askNewName,
              options: relayOptions,
              strictFallback: true,
            });
          };

          const askKindAgain = (): void => {
            const askKind = pickL(
              l(
                ["기존 프로젝트인가요, 신규 프로젝트인가요?\n1️⃣ 기존 프로젝트\n2️⃣ 신규 프로젝트"],
                ["Is this an existing project or a new project?\n1️⃣ Existing project\n2️⃣ New project"],
                ["既存プロジェクトですか？新規プロジェクトですか？\n1️⃣ 既存\n2️⃣ 新規"],
                ["这是已有项目还是新项目？\n1️⃣ 已有项目\n2️⃣ 新项目"],
              ),
              lang,
            );
            replyRuntime.sendInCharacterAutoMessage({
              agent,
              lang,
              scenario: "Ask the user to choose project kind with two options: existing or new.",
              fallback: askKind,
              options: relayOptions,
              strictFallback: true,
            });
          };

          const projectKind = detectProjectKindChoice(ceoMessage);
          if (projectKind === "existing") {
            promptExistingSelection(pendingBinding);
            return;
          }
          if (projectKind === "new") {
            promptNewProjectName(pendingBinding);
            return;
          }

          const snapshotRequestedAt = pendingBinding.requestedAt;
          void (async () => {
            const inferred = await inferProjectKindWithModel({ runAgentOneShot }, agent, lang, ceoMessage);
            const current = pendingProjectBindingByAgent.get(agent.id);
            if (!current || current.state !== "ask_kind") return;
            if (current.requestedAt !== snapshotRequestedAt) return;

            if (inferred === "existing") {
              promptExistingSelection(current);
              return;
            }
            if (inferred === "new") {
              promptNewProjectName(current);
              return;
            }
            askKindAgain();
          })().catch((err) => {
            console.warn(`[project-kind] async inference failed for ${agent.name}: ${String(err)}`);
            askKindAgain();
          });
          return;
        }

        if (pendingBinding.state === "ask_existing") {
          const fromRecent = selectExistingProjectFromCandidates(
            {
              detectProjectPath,
              normalizeTextField,
            },
            ceoMessage,
            pendingBinding.existingCandidates ?? [],
          );
          const resolvedBinding =
            fromRecent ??
            resolveProjectBindingFromText(
              {
                db,
                detectProjectPath,
                normalizeTextField,
              },
              ceoMessage,
            );
          if (!resolvedBinding) {
            const refreshedCandidates = pendingBinding.existingCandidates?.length
              ? pendingBinding.existingCandidates
              : loadRecentExistingProjects(
                  {
                    db,
                    normalizeTextField,
                  },
                  RECENT_EXISTING_PROJECT_LIMIT,
                );
            pendingProjectBindingByAgent.set(agent.id, {
              ...pendingBinding,
              requestedAt: nowMs(),
              existingCandidates: refreshedCandidates,
            });
            const recentLines = formatExistingProjectCandidateLines(normalizeTextField, refreshedCandidates, lang);
            const askExistingAgain = pickL(
              l(
                [
                  recentLines.length > 0
                    ? `기존 프로젝트를 찾지 못했습니다. 아래 목록에서 번호(1-${recentLines.length}) 또는 정확한 프로젝트 이름/절대경로를 다시 보내주세요.\n${recentLines.join("\n")}`
                    : "기존 프로젝트를 찾지 못했습니다. 프로젝트 절대경로나 정확한 프로젝트 이름을 다시 보내주세요.",
                ],
                [
                  recentLines.length > 0
                    ? `I couldn't resolve that project. Reply with a number (1-${recentLines.length}) from the list or send the exact project name/absolute path.\n${recentLines.join("\n")}`
                    : "I couldn't find that existing project. Send an absolute project path or the exact project name again.",
                ],
                [
                  recentLines.length > 0
                    ? `既存プロジェクトを特定できませんでした。番号(1-${recentLines.length}) または正確なプロジェクト名/絶対パスを再送してください。\n${recentLines.join("\n")}`
                    : "既存プロジェクトが見つかりませんでした。絶対パスまたは正確なプロジェクト名を再送してください。",
                ],
                [
                  recentLines.length > 0
                    ? `未能定位已有项目。请回复列表编号(1-${recentLines.length})，或重新发送准确项目名称/绝对路径。\n${recentLines.join("\n")}`
                    : "未找到该已有项目。请重新发送项目绝对路径或准确的项目名称。",
                ],
              ),
              lang,
            );
            replyRuntime.sendInCharacterAutoMessage({
              agent,
              lang,
              scenario:
                "The provided existing project could not be found. Ask for exact project name or absolute path again.",
              fallback: askExistingAgain,
              options: relayOptions,
              strictFallback: true,
            });
            return;
          }

          pendingProjectBindingByAgent.delete(agent.id);
          const mergedOptions: DelegationOptions = {
            ...relayOptions,
            ...resolvedBinding,
          };
          taskFlow.runTaskFlowWithResolvedProject(agent, pendingBinding.taskMessage, mergedOptions, lang);
          return;
        }

        if (pendingBinding.state === "ask_new_name") {
          const newProjectName = normalizeNewProjectNameInput(ceoMessage);
          if (!newProjectName) {
            const askNameAgain = pickL(
              l(
                ["신규 프로젝트 이름을 다시 알려주세요. 예: climpire-redesign"],
                ["Please provide the new project name again. Example: climpire-redesign"],
                ["新規プロジェクト名をもう一度送ってください。例: climpire-redesign"],
                ["请重新提供新项目名称。例如：climpire-redesign"],
              ),
              lang,
            );
            replyRuntime.sendInCharacterAutoMessage({
              agent,
              lang,
              scenario: "The project name was invalid. Ask for a valid new project name again with an example.",
              fallback: askNameAgain,
              options: relayOptions,
              strictFallback: true,
            });
            return;
          }

          pendingProjectBindingByAgent.set(agent.id, {
            ...pendingBinding,
            state: "ask_new_path",
            requestedAt: now,
            newProjectName,
          });
          const askNewPath = pickL(
            l(
              ["신규 프로젝트 절대경로를 보내주세요. 예: /Users/classys/Projects/climpire-redesign"],
              ["Send the new project's absolute path. Example: /Users/classys/Projects/climpire-redesign"],
              ["新規プロジェクトの絶対パスを送ってください。例: /Users/classys/Projects/climpire-redesign"],
              ["请发送新项目绝对路径。例如：/Users/classys/Projects/climpire-redesign"],
            ),
            lang,
          );
          replyRuntime.sendInCharacterAutoMessage({
            agent,
            lang,
            scenario: "Ask for the absolute path of the new project with a concrete example path.",
            fallback: askNewPath,
            options: relayOptions,
            strictFallback: true,
          });
          return;
        }

        if (pendingBinding.state === "ask_new_path") {
          const providedPath = extractAbsolutePathFromText(ceoMessage);
          if (!providedPath) {
            const askPathAgain = pickL(
              l(
                ["절대경로 형식으로 다시 보내주세요. 예: /Users/classys/Projects/climpire-redesign"],
                ["Please send it again as an absolute path. Example: /Users/classys/Projects/climpire-redesign"],
                ["絶対パス形式で再送してください。例: /Users/classys/Projects/climpire-redesign"],
                ["请用绝对路径格式重新发送。例如：/Users/classys/Projects/climpire-redesign"],
              ),
              lang,
            );
            replyRuntime.sendInCharacterAutoMessage({
              agent,
              lang,
              scenario: "Path format was invalid. Ask again for an absolute path with the same example.",
              fallback: askPathAgain,
              options: relayOptions,
              strictFallback: true,
            });
            return;
          }

          const binding = createProjectBindingFromNameAndPath(
            {
              db,
              normalizeTextField,
              nowMs,
            },
            pendingBinding.taskMessage,
            pendingBinding.newProjectName || `project-${new Date().toISOString().slice(0, 10)}`,
            providedPath,
          );
          if (!binding) {
            const askPathFail = pickL(
              l(
                ["프로젝트 생성에 실패했습니다. 신규 프로젝트 절대경로를 다시 보내주세요."],
                ["Failed to create the project. Please send the new project's absolute path again."],
                ["プロジェクト作成に失敗しました。新規プロジェクトの絶対パスを再送してください。"],
                ["创建项目失败。请重新发送新项目绝对路径。"],
              ),
              lang,
            );
            replyRuntime.sendInCharacterAutoMessage({
              agent,
              lang,
              scenario: "Project creation failed. Ask for the new project's absolute path again.",
              fallback: askPathFail,
              options: relayOptions,
              strictFallback: true,
            });
            return;
          }

          pendingProjectBindingByAgent.delete(agent.id);
          const mergedOptions: DelegationOptions = {
            ...relayOptions,
            projectId: binding.projectId,
            projectPath: binding.projectPath,
            projectContext: binding.projectContext,
          };
          taskFlow.runTaskFlowWithResolvedProject(agent, pendingBinding.taskMessage, mergedOptions, lang);
          return;
        }
      }
    }

    const taskMessage = ceoMessage;
    const useTaskFlow = shouldTreatDirectChatAsTask(ceoMessage, messageType);
    console.log(
      `[scheduleAgentReply] useTaskFlow=${useTaskFlow}, messageType=${messageType}, msg="${ceoMessage.slice(0, 50)}", taskMsg="${taskMessage.slice(0, 50)}"`,
    );
    if (useTaskFlow) {
      if (
        !hasProjectBinding(
          {
            normalizeTextField,
            resolveProjectFromOptions,
          },
          taskMessage,
          options,
        )
      ) {
        pendingProjectBindingByAgent.set(agent.id, {
          taskMessage,
          options: {
            ...options,
            messengerChannel: options.messengerChannel,
            messengerTargetId: options.messengerTargetId,
            messengerSessionKey: options.messengerSessionKey,
          },
          state: "ask_kind",
          requestedAt: now,
        });
        const askProject = pickL(
          l(
            [
              "프로젝트를 먼저 정해야 합니다. 기존 프로젝트인가요, 신규 프로젝트인가요?\n1️⃣ 기존 프로젝트\n2️⃣ 신규 프로젝트",
            ],
            [
              "I need to fix the project first. Is this an existing project or a new project?\n1️⃣ Existing project\n2️⃣ New project",
            ],
            ["先に対象プロジェクトを決める必要があります。既存ですか？新規ですか？\n1️⃣ 既存\n2️⃣ 新規"],
            ["需要先确定项目。是已有项目还是新项目？\n1️⃣ 已有项目\n2️⃣ 新项目"],
          ),
          resolveLang(ceoMessage),
        );
        replyRuntime.sendInCharacterAutoMessage({
          agent,
          lang: resolveLang(ceoMessage),
          scenario: "Before task execution, ask project kind with two options: existing or new.",
          fallback: askProject,
          options,
          strictFallback: true,
        });
        return;
      }
      taskFlow.runTaskFlowWithResolvedProject(agent, taskMessage, options, resolveLang(ceoMessage));
      return;
    }

    if (isProjectProgressInquiry(ceoMessage, messageType)) {
      sendProjectProgressReply(
        {
          db,
          l,
          pickL,
          resolveLang,
          resolveProjectFromOptions,
          detectProjectPath,
          normalizeTextField,
          sendAgentMessage,
          sendInCharacterAutoMessage: replyRuntime.sendInCharacterAutoMessage,
          composeInCharacterAutoMessage: replyRuntime.composeInCharacterAutoMessage,
          relayReplyToMessenger: replyRuntime.relayReplyToMessenger,
        },
        agent,
        ceoMessage,
        options,
      );
      return;
    }

    replyRuntime.runDirectReplyExecution(agent, ceoMessage, messageType, options);
  }

  function resetDirectChatState(agentId: string): { clearedPendingProjectBinding: boolean } {
    const normalized = agentId.trim();
    if (!normalized) {
      return { clearedPendingProjectBinding: false };
    }
    const clearedPendingProjectBinding = pendingProjectBindingByAgent.delete(normalized);
    return { clearedPendingProjectBinding };
  }

  return {
    shouldTreatDirectChatAsTask,
    createDirectAgentTaskAndRun: taskFlow.createDirectAgentTaskAndRun,
    scheduleAgentReply,
    resetDirectChatState,
  };
}
