import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

import * as api from "../api";
import { buildDecisionInboxItems } from "../components/chat/decision-inbox";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import { normalizeLanguage, pickLang } from "../i18n";
import type { Agent } from "../types";
import { mapWorkflowDecisionItemsLocalized } from "./decision-inbox";

interface UseDecisionActionsParams {
  agents: Agent[];
  language: string;
  openTaskReport?: (taskId: string) => Promise<void>;
  scheduleLiveSync: (delayMs?: number) => void;
  setShowDecisionInbox: Dispatch<SetStateAction<boolean>>;
  setDecisionInboxLoading: Dispatch<SetStateAction<boolean>>;
  setDecisionInboxItems: Dispatch<SetStateAction<DecisionInboxItem[]>>;
  setDecisionReplyBusyKey: Dispatch<SetStateAction<string | null>>;
}

function formatBlockedTaskGuidance(
  locale: ReturnType<typeof normalizeLanguage>,
  blockedTask: { title?: string; reason?: string },
): string {
  const reason = String(blockedTask.reason ?? "").trim();
  const title = String(blockedTask.title ?? "").trim() || pickLang(locale, {
    ko: "이름 없는 태스크",
    en: "Unnamed task",
    ja: "名称未設定タスク",
    zh: "未命名任务",
  });

  const guidance =
    reason === "unfinished_subtasks"
      ? pickLang(locale, {
          ko: "업무 보드에서 서브태스크를 펼쳐 원부서 준비 작업부터 먼저 처리하세요",
          en: "Expand the subtasks on the task board and finish the remaining owner-side prep items first",
          ja: "タスクボードでサブタスクを展開し、オーナー側の準備タスクから先に処理してください",
          zh: "请在任务看板中展开子任务，先处理剩余的原部门准备事项",
        })
      : reason === "collaboration_children_pending"
        ? pickLang(locale, {
            ko: "외부 협업 하위 작업이 아직 진행 중입니다",
            en: "External collaboration child tasks are still in progress",
            ja: "外部協業の子タスクがまだ進行中です",
            zh: "外部协作子任务仍在进行中",
          })
        : reason === "video_artifact_missing"
          ? pickLang(locale, {
              ko: "영상 산출물이 아직 준비되지 않았습니다",
              en: "The required video artifact is not ready yet",
              ja: "必要な動画成果物がまだ用意されていません",
              zh: "所需的视频产物尚未准备好",
            })
          : pickLang(locale, {
              ko: "세부 게이트를 먼저 확인해 주세요",
              en: "Check the remaining gate details first",
              ja: "残っているゲート内容を先に確認してください",
              zh: "请先检查剩余门禁详情",
            });

  return `- ${title}: ${guidance}`;
}

export function useDecisionActions({
  agents,
  language,
  openTaskReport,
  scheduleLiveSync,
  setShowDecisionInbox,
  setDecisionInboxLoading,
  setDecisionInboxItems,
  setDecisionReplyBusyKey,
}: UseDecisionActionsParams) {
  const loadDecisionInbox = useCallback(async () => {
    setDecisionInboxLoading(true);
    try {
      const [allMessages, workflowDecisionItems] = await Promise.all([
        api.getMessages({ limit: 500 }),
        api.getDecisionInbox(),
      ]);
      const agentDecisionItems = buildDecisionInboxItems(allMessages, agents);
      const workflowItems = mapWorkflowDecisionItemsLocalized(workflowDecisionItems, language);
      const merged = [...workflowItems, ...agentDecisionItems];
      const deduped = new Map<string, DecisionInboxItem>();
      for (const item of merged) deduped.set(item.id, item);
      setDecisionInboxItems(Array.from(deduped.values()).sort((a, b) => b.createdAt - a.createdAt));
    } catch (error) {
      console.error("Load decision inbox failed:", error);
    } finally {
      setDecisionInboxLoading(false);
    }
  }, [agents, language, setDecisionInboxLoading, setDecisionInboxItems]);

  const handleOpenDecisionInbox = useCallback(() => {
    setShowDecisionInbox(true);
    void loadDecisionInbox();
  }, [loadDecisionInbox, setShowDecisionInbox]);

  const handleReplyDecisionOption = useCallback(
    async (
      item: DecisionInboxItem,
      optionNumber: number,
      payloadInput?: { note?: string; selected_option_numbers?: number[] },
    ) => {
      const option = item.options.find((entry) => entry.number === optionNumber);
      if (!option) return;
      const busyKey = `${item.id}:${option.number}`;
      setDecisionReplyBusyKey(busyKey);
      const locale = normalizeLanguage(language);
      try {
        if (item.kind === "agent_request") {
          if (!item.agentId) return;
          const replyContent = pickLang(locale, {
            ko: `[의사결정 회신] ${option.number}번으로 진행해 주세요. (${option.label})`,
            en: `[Decision Reply] Please proceed with option ${option.number}. (${option.label})`,
            ja: `[意思決定返信] ${option.number}番で進めてください。(${option.label})`,
            zh: `[决策回复] 请按选项 ${option.number} 推进。（${option.label}）`,
          });
          await api.sendMessage({
            receiver_type: "agent",
            receiver_id: item.agentId,
            content: replyContent,
            message_type: "chat",
            task_id: item.taskId ?? undefined,
          });
          setDecisionInboxItems((prev) => prev.filter((entry) => entry.id !== item.id));
        } else {
          const selectedAction = option.action ?? "";
          let payload: { note?: string; target_task_id?: string; selected_option_numbers?: number[] } | undefined;
          if (selectedAction === "add_followup_request") {
            const note = payloadInput?.note?.trim() ?? "";
            if (!note) {
              window.alert(
                pickLang(locale, {
                  ko: "추가요청사항이 비어 있습니다.",
                  en: "Additional request is empty.",
                  ja: "追加要請が空です。",
                  zh: "追加请求内容为空。",
                }),
              );
              return;
            }
            payload = { note, ...(item.taskId ? { target_task_id: item.taskId } : {}) };
          } else if (item.kind === "review_round_pick") {
            const selectedOptionNumbers = payloadInput?.selected_option_numbers;
            const note = payloadInput?.note?.trim() ?? "";
            payload = {
              ...(note ? { note } : {}),
              ...(Array.isArray(selectedOptionNumbers) ? { selected_option_numbers: selectedOptionNumbers } : {}),
            };
          }
          const replyResult = await api.replyDecisionInbox(item.id, optionNumber, payload);
          if (replyResult.action === "start_project_review_blocked") {
            const blockedTasks = (replyResult.blocked_tasks ?? []).slice(0, 3);
            const blockedLines = blockedTasks.map((entry) => formatBlockedTaskGuidance(locale, entry));
            const blockedSummary =
              blockedLines.length > 0
                ? `\n\n${blockedLines.join("\n")}`
                : pickLang(locale, {
                    ko: "\n\n세부 사유는 태스크 로그를 확인해 주세요.",
                    en: "\n\nCheck task logs for details.",
                    ja: "\n\n詳細はタスクログを確認してください。",
                    zh: "\n\n请查看任务日志了解详情。",
                  });
            window.alert(
              pickLang(locale, {
                ko: `팀장 회의 시작이 보류되었습니다. 아래 작업부터 확인해 주세요.${blockedSummary}`,
                en: `Team-lead meeting start is on hold. Start with the items below.${blockedSummary}`,
                ja: `チームリーダー会議の開始は保留です。まず以下の項目を確認してください。${blockedSummary}`,
                zh: `组长评审会议暂缓启动。请先处理下面这些项目。${blockedSummary}`,
              }),
            );
            const firstBlockedTaskId = String(blockedTasks[0]?.id ?? "").trim();
            if (firstBlockedTaskId && openTaskReport) {
              try {
                await openTaskReport(firstBlockedTaskId);
              } catch (openError) {
                console.error("Open blocked task report failed:", openError);
              }
            }
          }
          if (replyResult.resolved) {
            setDecisionInboxItems((prev) => prev.filter((entry) => entry.id !== item.id));
            scheduleLiveSync(40);
          }
          await loadDecisionInbox();
        }
      } catch (error) {
        console.error("Decision reply failed:", error);
        window.alert(
          pickLang(locale, {
            ko: "의사결정 회신 전송에 실패했습니다. 잠시 후 다시 시도해 주세요.",
            en: "Failed to send decision reply. Please try again.",
            ja: "意思決定返信の送信に失敗しました。もう一度お試しください。",
            zh: "发送决策回复失败，请稍后重试。",
          }),
        );
      } finally {
        setDecisionReplyBusyKey((prev) => (prev === busyKey ? null : prev));
      }
    },
    [language, loadDecisionInbox, openTaskReport, scheduleLiveSync, setDecisionInboxItems, setDecisionReplyBusyKey],
  );

  return {
    loadDecisionInbox,
    handleOpenDecisionInbox,
    handleReplyDecisionOption,
  };
}
