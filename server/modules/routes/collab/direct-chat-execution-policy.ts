import { isProjectProgressInquiry, shouldTreatDirectChatAsTask } from "./direct-chat-intent-utils.ts";

export type DirectChatIntentClass =
  | "general_qna"
  | "project_progress"
  | "project_action"
  | "task_assign"
  | "agent_meta";

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

const PROJECT_STRUCTURE_PATTERNS = [
  /(구조|동작 원리|어떻게 돌아가|흐름|아키텍처)/i,
  /\b(structure|architecture|how\s+.*works?|flow)\b/i,
  /(構造|仕組み|どう動く|アーキテクチャ)/i,
  /(结构|原理|怎么运作|架构)/i,
];

const AGENT_META_PATTERNS = [
  /(너\s*뭐\s*할\s*수|무슨\s*역할|소개해|정체가|누구야|어떤\s*기능)/i,
  /\b(who are you|what can you do|your role|introduce yourself|what do you do)\b/i,
  /(あなたは誰|何ができる|役割|自己紹介|どんな機能)/i,
  /(你是谁|你能做什么|你的角色|自我介绍|有什么功能)/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyDirectChatIntent(text: string, messageType: string = "chat"): DirectChatIntentClass {
  const normalized = text.trim();
  if (!normalized) return "general_qna";

  if (shouldTreatDirectChatAsTask(normalized, messageType)) return "task_assign";
  if (isProjectProgressInquiry(normalized, messageType)) return "project_progress";
  if (matchesAny(normalized, AGENT_META_PATTERNS)) return "agent_meta";

  const hasProjectScope = matchesAny(normalized, PROJECT_SCOPE_PATTERNS);
  const hasProjectAction = matchesAny(normalized, PROJECT_ACTION_PATTERNS);
  const hasProjectStructure = matchesAny(normalized, PROJECT_STRUCTURE_PATTERNS);
  if (hasProjectScope && (hasProjectAction || hasProjectStructure)) {
    return "project_action";
  }

  return "general_qna";
}

export function requiresProjectContextForDirectChat(text: string, messageType: string = "chat"): boolean {
  const classification = classifyDirectChatIntent(text, messageType);
  return (
    classification === "project_progress" ||
    classification === "project_action" ||
    classification === "task_assign"
  );
}
