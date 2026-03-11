import { I18nProvider } from "../i18n";

interface AppLoadingScreenProps {
  language: string;
  title: string;
  subtitle: string;
}

export default function AppLoadingScreen({ language, title, subtitle }: AppLoadingScreenProps) {
  return (
    <I18nProvider language={language}>
      <div className="min-h-[100dvh] flex items-center justify-center" style={{ background: "var(--th-bg-primary)" }}>
        <div className="text-center">
          <div className="text-5xl mb-4 animate-agent-bounce">🏢</div>
          <div className="text-lg font-medium" style={{ color: "var(--th-text-secondary)" }}>
            {title}
          </div>
          <div className="text-sm mt-1" style={{ color: "var(--th-text-muted)" }}>
            {subtitle}
          </div>
        </div>
      </div>
    </I18nProvider>
  );
}
