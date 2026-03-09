import { useEffect, useState } from "react";
import type { ProjectDecisionEventItem, ProjectReportHistoryItem, ProjectTaskHistoryItem, WorkflowPackEffectivePreview } from "../../api";
import type { Project, WorkflowPackKey } from "../../types";
import type { GroupedProjectTaskCard, ProjectI18nTranslate } from "./types";
import { fmtTime } from "./utils";

interface ProjectInsightsPanelProps {
  t: ProjectI18nTranslate;
  selectedProject: Project | null;
  loadingDetail: boolean;
  isCreating: boolean;
  groupedTaskCards: GroupedProjectTaskCard[];
  sortedReports: ProjectReportHistoryItem[];
  sortedDecisionEvents: ProjectDecisionEventItem[];
  getDecisionEventLabel: (eventType: ProjectDecisionEventItem["event_type"]) => string;
  handleOpenTaskDetail: (taskId: string) => Promise<void>;
  handlePreviewWorkflowPack: (packKey: WorkflowPackKey, projectPath: string) => Promise<WorkflowPackEffectivePreview>;
}

export default function ProjectInsightsPanel({
  t,
  selectedProject,
  loadingDetail,
  isCreating,
  groupedTaskCards,
  sortedReports,
  sortedDecisionEvents,
  getDecisionEventLabel,
  handleOpenTaskDetail,
  handlePreviewWorkflowPack,
}: ProjectInsightsPanelProps) {
  const [effectivePackPreview, setEffectivePackPreview] = useState<WorkflowPackEffectivePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setEffectivePackPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }, [selectedProject?.id]);

  return (
    <div className="min-w-0 space-y-4">
      <div className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-white">
            {t({ ko: "프로젝트 정보", en: "Project Info", ja: "プロジェクト情報", zh: "项目信息" })}
          </h4>
          {selectedProject?.github_repo && (
            <a
              href={`https://github.com/${selectedProject.github_repo}`}
              target="_blank"
              rel="noopener noreferrer"
              title={selectedProject.github_repo}
              className="flex items-center gap-1 rounded-md border border-slate-600 px-2 py-0.5 text-[11px] text-slate-300 transition hover:border-blue-500 hover:text-white"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              {selectedProject.github_repo}
            </a>
          )}
        </div>
        {loadingDetail ? (
          <p className="mt-2 text-xs text-slate-400">
            {t({ ko: "불러오는 중...", en: "Loading...", ja: "読み込み中...", zh: "加载中..." })}
          </p>
        ) : isCreating ? (
          <p className="mt-2 text-xs text-slate-500">
            {t({
              ko: "신규 프로젝트를 입력 중입니다",
              en: "Creating a new project",
              ja: "新規プロジェクトを入力中です",
              zh: "正在输入新项目",
            })}
          </p>
        ) : !selectedProject ? (
          <p className="mt-2 text-xs text-slate-500">
            {t({ ko: "프로젝트를 선택하세요", en: "Select a project", ja: "プロジェクトを選択", zh: "请选择项目" })}
          </p>
        ) : (
          <div className="mt-2 space-y-2 text-xs">
            <p className="text-slate-200">
              <span className="text-slate-500">ID:</span> {selectedProject.id}
            </p>
            <p className="break-all text-slate-200">
              <span className="text-slate-500">Path:</span> {selectedProject.project_path}
            </p>
            <p className="break-all text-slate-200">
              <span className="text-slate-500">Goal:</span> {selectedProject.core_goal}
            </p>
            <p className="text-slate-200">
              <span className="text-slate-500">
                {t({ ko: "DB 기본 Pack", en: "DB Default Pack", ja: "DB既定Pack", zh: "DB 默认 Pack" })}:
              </span>{" "}
              {selectedProject.default_pack_key || "development"}
            </p>
            <p className="text-slate-200">
              <span className="text-slate-500">
                {t({ ko: "파일 감지 Pack", en: "Detected File Pack", ja: "検出されたファイルPack", zh: "文件检测 Pack" })}:
              </span>{" "}
              {selectedProject.detected_workflow_pack_key || "-"}
            </p>
            <p className="text-slate-200">
              <span className="text-slate-500">
                {t({ ko: "현재 Source", en: "Current Source", ja: "現在のSource", zh: "当前 Source" })}:
              </span>{" "}
              {selectedProject.workflow_pack_source || "-"}
            </p>
            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500">
                  {t({ ko: "Override", en: "Override", ja: "Override", zh: "Override" })}:
                </span>
                {selectedProject.workflow_pack_override_applied ? (
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                    {t({ ko: "파일 적용됨", en: "File override active", ja: "ファイル適用中", zh: "文件覆盖生效" })}
                  </span>
                ) : (
                  <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[11px] text-slate-400">
                    {t({ ko: "DB만 사용", en: "DB only", ja: "DBのみ", zh: "仅使用 DB" })}
                  </span>
                )}
              </div>
              <p className="text-slate-200">
                <span className="text-slate-500">
                  {t({ ko: "Override 필드", en: "Override Fields", ja: "Override対象", zh: "覆盖字段" })}:
                </span>{" "}
                {selectedProject.workflow_pack_override_fields && selectedProject.workflow_pack_override_fields.length > 0
                  ? selectedProject.workflow_pack_override_fields.join(", ")
                  : "-"}
              </p>
              {selectedProject.workflow_pack_preview_key && selectedProject.project_path && (
                <div className="space-y-2">
                  <button
                    type="button"
                    disabled={previewLoading}
                    onClick={async () => {
                      setPreviewLoading(true);
                      setPreviewError(null);
                      try {
                        const preview = await handlePreviewWorkflowPack(
                          selectedProject.workflow_pack_preview_key as WorkflowPackKey,
                          selectedProject.project_path,
                        );
                        setEffectivePackPreview(preview);
                      } catch (error) {
                        const message = error instanceof Error ? error.message : "Failed to load preview";
                        setPreviewError(message);
                      } finally {
                        setPreviewLoading(false);
                      }
                    }}
                    className="rounded-md border border-blue-500/40 px-2.5 py-1 text-[11px] font-medium text-blue-200 transition hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {previewLoading
                      ? t({ ko: "Preview 불러오는 중...", en: "Loading Preview...", ja: "Preview 読み込み中...", zh: "正在加载预览..." })
                      : t({ ko: "Effective Pack Preview", en: "Effective Pack Preview", ja: "Effective Pack Preview", zh: "Effective Pack Preview" })}
                  </button>
                  {previewError && <p className="text-[11px] text-rose-300">{previewError}</p>}
                  {effectivePackPreview && (
                    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/70 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
                        <span>{effectivePackPreview.pack.key}</span>
                        <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[10px] text-slate-400">
                          {effectivePackPreview.source}
                        </span>
                        {effectivePackPreview.override_applied && (
                          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                            {t({ ko: "override 적용", en: "override applied", ja: "override 適用", zh: "已应用 override" })}
                          </span>
                        )}
                      </div>
                      {effectivePackPreview.warnings.length > 0 && (
                        <div className="space-y-1">
                          {effectivePackPreview.warnings.map((warning) => (
                            <p key={warning} className="text-[11px] text-amber-300">
                              {warning}
                            </p>
                          ))}
                        </div>
                      )}
                      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-200">
                        {JSON.stringify(effectivePackPreview.pack, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <h4 className="text-sm font-semibold text-white">
          {t({ ko: "작업 이력", en: "Task History", ja: "作業履歴", zh: "任务历史" })}
        </h4>
        {!selectedProject ? (
          <p className="mt-2 text-xs text-slate-500">-</p>
        ) : groupedTaskCards.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            {t({ ko: "연결된 작업이 없습니다", en: "No mapped tasks", ja: "紐づくタスクなし", zh: "没有映射任务" })}
          </p>
        ) : (
          <div className="mt-2 max-h-56 overflow-x-hidden overflow-y-auto space-y-2 pr-1">
            {groupedTaskCards.map((group) => (
              <button
                key={group.root.id}
                type="button"
                onClick={() => void handleOpenTaskDetail(group.root.id)}
                className="w-full min-w-0 overflow-hidden rounded-lg border border-slate-700/70 bg-slate-900/60 px-3 py-2 text-left transition hover:border-blue-500/70 hover:bg-slate-900"
              >
                <p className="whitespace-pre-wrap break-all text-xs font-semibold text-slate-100">{group.root.title}</p>
                <p className="mt-1 break-all text-[11px] text-slate-400">
                  {group.root.status} · {group.root.task_type} · {fmtTime(group.root.created_at)}
                </p>
                <p className="mt-1 break-all text-[11px] text-slate-500">
                  {t({ ko: "담당", en: "Owner", ja: "担当", zh: "负责人" })}:{" "}
                  {group.root.assigned_agent_name_ko || group.root.assigned_agent_name || "-"}
                </p>
                <p className="mt-1 text-[11px] text-blue-300">
                  {t({ ko: "하위 작업", en: "Sub tasks", ja: "サブタスク", zh: "子任务" })}: {group.children.length}
                </p>
                {group.children.length > 0 && (
                  <div className="mt-1 space-y-1">
                    {group.children.slice(0, 3).map((child: ProjectTaskHistoryItem) => (
                      <p key={child.id} className="whitespace-pre-wrap break-all text-[11px] text-slate-500">
                        - {child.title}
                      </p>
                    ))}
                    {group.children.length > 3 && (
                      <p className="text-[11px] text-slate-500">+{group.children.length - 3}</p>
                    )}
                  </div>
                )}
                <p className="mt-2 text-right text-[11px] text-emerald-300">
                  {t({
                    ko: "카드 클릭으로 상세 보기",
                    en: "Click card for details",
                    ja: "クリックで詳細表示",
                    zh: "点击卡片查看详情",
                  })}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <h4 className="text-sm font-semibold text-white">
          {t({ ko: "보고서 이력(프로젝트 매핑)", en: "Mapped Reports", ja: "紐づくレポート", zh: "映射报告" })}
        </h4>
        {!selectedProject ? (
          <p className="mt-2 text-xs text-slate-500">-</p>
        ) : sortedReports.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            {t({
              ko: "연결된 보고서가 없습니다",
              en: "No mapped reports",
              ja: "紐づくレポートなし",
              zh: "没有映射报告",
            })}
          </p>
        ) : (
          <div className="mt-2 max-h-56 overflow-x-hidden overflow-y-auto space-y-2 pr-1">
            {sortedReports.map((row) => (
              <div
                key={row.id}
                className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-700/70 bg-slate-900/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="whitespace-pre-wrap break-all text-xs font-medium text-slate-100">{row.title}</p>
                  <p className="text-[11px] text-slate-400">{fmtTime(row.completed_at || row.created_at)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleOpenTaskDetail(row.id)}
                  className="shrink-0 rounded-md bg-emerald-700 px-2 py-1 text-[11px] text-white hover:bg-emerald-600"
                >
                  {t({ ko: "열람", en: "Open", ja: "表示", zh: "查看" })}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <h4 className="text-sm font-semibold text-white">
          {t({ ko: "대표 선택사항", en: "Representative Decisions", ja: "代表選択事項", zh: "代表选择事项" })}
        </h4>
        {!selectedProject ? (
          <p className="mt-2 text-xs text-slate-500">-</p>
        ) : sortedDecisionEvents.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            {t({
              ko: "기록된 대표 의사결정이 없습니다",
              en: "No representative decision records",
              ja: "代表意思決定の記録はありません",
              zh: "暂无代表决策记录",
            })}
          </p>
        ) : (
          <div className="mt-2 max-h-56 overflow-x-hidden overflow-y-auto space-y-2 pr-1">
            {sortedDecisionEvents.map((event) => {
              let selectedLabels: string[] = [];
              if (event.selected_options_json) {
                try {
                  const parsed = JSON.parse(event.selected_options_json) as Array<{ label?: unknown }>;
                  selectedLabels = Array.isArray(parsed)
                    ? parsed
                        .map((row) => (typeof row?.label === "string" ? row.label.trim() : ""))
                        .filter((label) => label.length > 0)
                    : [];
                } catch {
                  selectedLabels = [];
                }
              }

              return (
                <div
                  key={`${event.id}-${event.created_at}`}
                  className="rounded-lg border border-slate-700/70 bg-slate-900/60 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-semibold text-slate-100">
                      {getDecisionEventLabel(event.event_type)}
                    </p>
                    <p className="text-[11px] text-slate-400">{fmtTime(event.created_at)}</p>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-all text-[11px] text-slate-300">{event.summary}</p>
                  {selectedLabels.length > 0 && (
                    <p className="mt-1 whitespace-pre-wrap break-all text-[11px] text-blue-300">
                      {t({ ko: "선택 내용", en: "Selected Items", ja: "選択内容", zh: "已选内容" })}:{" "}
                      {selectedLabels.join(" / ")}
                    </p>
                  )}
                  {event.note && event.note.trim().length > 0 && (
                    <p className="mt-1 whitespace-pre-wrap break-all text-[11px] text-emerald-300">
                      {t({ ko: "추가 요청사항", en: "Additional Request", ja: "追加要請事項", zh: "追加请求事项" })}:{" "}
                      {event.note}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
