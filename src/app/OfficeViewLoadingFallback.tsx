type OfficeViewLoadingFallbackProps = {
  uiLanguage: string;
};

const FALLBACK_COPY: Record<string, string> = {
  ko: "오피스 화면을 불러오는 중...",
  ja: "オフィス画面を読み込み中...",
  zh: "正在加载办公室视图...",
  en: "Loading office view...",
};

function resolveFallbackCopy(uiLanguage: string): string {
  if (uiLanguage === "ko" || uiLanguage === "ja" || uiLanguage === "zh") {
    return FALLBACK_COPY[uiLanguage];
  }
  return FALLBACK_COPY.en;
}

export default function OfficeViewLoadingFallback({ uiLanguage }: OfficeViewLoadingFallbackProps) {
  const loadingText = resolveFallbackCopy(uiLanguage);

  return (
    <div className="w-full space-y-4" aria-busy="true" aria-live="polite">
      <div className="rounded-3xl border border-slate-800/60 bg-slate-950/60 p-4 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.95)]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="space-y-2">
            <div className="h-3 w-24 rounded-full bg-slate-800 animate-pulse" />
            <div className="h-5 w-44 rounded-full bg-slate-700 animate-pulse" />
          </div>
          <div className="h-9 w-32 rounded-full bg-slate-800 animate-pulse" />
        </div>
        <div className="relative overflow-hidden rounded-[28px] border border-slate-800/70 bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.16),_transparent_40%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-5 min-h-[56dvh]">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.8fr_1fr]">
            <div className="rounded-[24px] border border-slate-800/60 bg-slate-900/40 p-4">
              <div className="mb-4 flex gap-3">
                <div className="h-10 w-10 rounded-2xl bg-slate-800 animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-20 rounded-full bg-slate-800 animate-pulse" />
                  <div className="h-4 w-36 rounded-full bg-slate-700 animate-pulse" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {Array.from({ length: 6 }, (_, index) => (
                  <div
                    key={`office-room-skeleton-${index}`}
                    className="h-28 rounded-[20px] border border-slate-800/60 bg-slate-900/50 animate-pulse"
                  />
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <div className="rounded-[24px] border border-slate-800/60 bg-slate-900/50 p-4">
                <div className="h-4 w-24 rounded-full bg-slate-700 animate-pulse" />
                <div className="mt-4 space-y-3">
                  {Array.from({ length: 4 }, (_, index) => (
                    <div
                      key={`office-agent-skeleton-${index}`}
                      className="flex items-center gap-3 rounded-2xl border border-slate-800/60 bg-slate-950/60 px-3 py-3"
                    >
                      <div className="h-10 w-10 rounded-2xl bg-slate-800 animate-pulse" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-24 rounded-full bg-slate-800 animate-pulse" />
                        <div className="h-3 w-16 rounded-full bg-slate-900 animate-pulse" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-[24px] border border-slate-800/60 bg-slate-900/50 p-4">
                <div className="h-4 w-28 rounded-full bg-slate-700 animate-pulse" />
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {Array.from({ length: 4 }, (_, index) => (
                    <div
                      key={`office-metric-skeleton-${index}`}
                      className="h-20 rounded-2xl border border-slate-800/60 bg-slate-950/60 animate-pulse"
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 text-xs text-slate-400">{loadingText}</div>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-800/60 bg-slate-950/60 p-4">
        <div className="mb-3 h-4 w-32 rounded-full bg-slate-700 animate-pulse" />
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={`office-cli-skeleton-${index}`}
              className="h-24 rounded-2xl border border-slate-800/60 bg-slate-900/50 animate-pulse"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
