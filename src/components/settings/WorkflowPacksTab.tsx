import type { ChangeEvent } from "react";
import type { WorkflowPacksTabProps } from "./types";

export default function WorkflowPacksTab({
  t,
  packs,
  loading,
  importError,
  importSuccess,
  exportingKey,
  importing,
  onRefresh,
  onExportAll,
  onExportOne,
  onImportFile,
}: WorkflowPacksTabProps) {
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void onImportFile(file);
    event.target.value = "";
  };

  return (
    <section className="space-y-4 rounded-xl border border-slate-700/50 bg-slate-800/60 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
            {t({ ko: "Workflow Pack 백업/복원", en: "Workflow Pack Backup/Restore", ja: "Workflow Pack バックアップ/復元", zh: "Workflow Pack 备份/恢复" })}
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            {t({
              ko: "현재 workflow pack 설정을 JSON으로 내보내고 다시 가져올 수 있습니다.",
              en: "Export current workflow pack settings to JSON and import them back.",
              ja: "現在の Workflow Pack 設定を JSON としてエクスポート/インポートできます。",
              zh: "可将当前 Workflow Pack 设置导出为 JSON 并重新导入。",
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void onRefresh()}
            disabled={loading}
            className="rounded-lg border border-slate-600/50 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700/40 disabled:opacity-50"
          >
            {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "刷新" })}
          </button>
          <button
            onClick={() => void onExportAll()}
            disabled={loading || importing}
            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {exportingKey === "__all__"
              ? t({ ko: "내보내는 중...", en: "Exporting...", ja: "エクスポート中...", zh: "导出中..." })
              : t({ ko: "전체 Export", en: "Export All", ja: "すべて Export", zh: "导出全部" })}
          </button>
          <label className="cursor-pointer rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500">
            {importing
              ? t({ ko: "가져오는 중...", en: "Importing...", ja: "インポート中...", zh: "导入中..." })
              : t({ ko: "JSON Import", en: "Import JSON", ja: "JSON Import", zh: "导入 JSON" })}
            <input type="file" accept="application/json,.json" className="hidden" onChange={handleFileChange} />
          </label>
        </div>
      </div>

      {importError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{importError}</div>}
      {importSuccess && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {importSuccess}
        </div>
      )}

      {loading ? (
        <div className="py-6 text-center text-xs text-slate-500">
          {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "加载中..." })}
        </div>
      ) : (
        <div className="space-y-3">
          {packs.map((pack) => (
            <div key={pack.key} className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{pack.name}</p>
                  <p className="truncate text-[11px] text-slate-500">{pack.key}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-2 py-1 text-[10px] font-medium ${
                      pack.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700/70 text-slate-400"
                    }`}
                  >
                    {pack.enabled
                      ? t({ ko: "활성", en: "Enabled", ja: "有効", zh: "启用" })
                      : t({ ko: "비활성", en: "Disabled", ja: "無効", zh: "禁用" })}
                  </span>
                  <button
                    onClick={() => void onExportOne(pack.key)}
                    disabled={Boolean(exportingKey) || importing}
                    className="rounded-lg border border-slate-600/50 px-3 py-1.5 text-[11px] font-medium text-slate-200 transition-colors hover:bg-slate-700/40 disabled:opacity-50"
                  >
                    {exportingKey === pack.key
                      ? t({ ko: "내보내는 중...", en: "Exporting...", ja: "エクスポート中...", zh: "导出中..." })
                      : t({ ko: "Export", en: "Export", ja: "Export", zh: "导出" })}
                  </button>
                </div>
              </div>
            </div>
          ))}
          {packs.length <= 0 && (
            <div className="py-6 text-center text-xs text-slate-500">
              {t({ ko: "표시할 workflow pack이 없습니다.", en: "No workflow packs available.", ja: "表示する Workflow Pack がありません。", zh: "没有可显示的 Workflow Pack。" })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
