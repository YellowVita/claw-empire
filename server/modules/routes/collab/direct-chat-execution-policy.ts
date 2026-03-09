import { isProjectProgressInquiry, shouldTreatDirectChatAsTask } from "./direct-chat-intent-utils.ts";

const PROJECT_SCOPE_PATTERNS = [
  /(현재\s*)?(프로젝트|저장소|리포지토리|코드베이스|코드|앱|서비스|빌드|테스트|로그|문서|태스크|작업)/i,
  /\b(this|current)?\s*(project|repo|repository|codebase|code|app|service|build|test|logs?|docs?|task|tasks)\b/i,
  /(この|現在の)?\s*(プロジェクト|リポジトリ|コードベース|コード|アプリ|サービス|ビルド|テスト|ログ|ドキュメント|タスク)/i,
  /(当前|这个)?\s*(项目|仓库|代码库|代码|应用|服务|构建|测试|日志|文档|任务)/i,
];

const PROJECT_ACTION_PATTERNS = [
  /(분석|검토|리뷰|수정|고쳐|구현|디버그|확인|조사|해결|실행|진행|착수|시작)/i,
  /\b(analy[sz]e|review|inspect|fix|modify|edit|implement|debug|investigate|resolve|run|execute|proceed|start|continue)\b/i,
  /(分析|レビュー|確認|修正|編集|実装|デバッグ|調査|解決|実行|開始|継続)/i,
  /(分析|评审|检查|修复|修改|编辑|实现|调试|调查|解决|执行|开始|继续)/i,
];

export function requiresProjectContextForDirectChat(text: string, messageType: string = "chat"): boolean {
  if (shouldTreatDirectChatAsTask(text, messageType)) return true;
  if (isProjectProgressInquiry(text, messageType)) return true;

  const normalized = text.trim();
  if (!normalized) return false;

  return (
    PROJECT_SCOPE_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    PROJECT_ACTION_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}
