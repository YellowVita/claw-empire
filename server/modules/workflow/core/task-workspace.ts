import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const TASK_WORKSPACE_RUNTIME_ARTIFACT_EXACT_PATHS = [
  "tasks/todo.md",
  "tasks/lessons.md",
  "tasks/review.md",
] as const;

export const TASK_WORKSPACE_RUNTIME_ARTIFACT_PREFIXES = [
  "tasks/runtime/",
  "tasks/subtasks/",
  ".climpire/runtime/",
] as const;

export const TASK_WORKSPACE_RUNTIME_ARTIFACT_RESET_TARGETS = [
  ...TASK_WORKSPACE_RUNTIME_ARTIFACT_EXACT_PATHS,
  "tasks/runtime",
  "tasks/subtasks",
  ".climpire/runtime",
] as const;

export const TASK_WORKSPACE_PLAN_LABEL = "task run sheet current_plan";
export const TASK_WORKSPACE_REVIEW_LABEL = "task run sheet review_checklist + recent review messages";
export const TASK_WORKSPACE_LESSONS_LABEL = "lessons log workspace";

function getTaskWorkspaceShortId(taskId: string): string {
  const sanitized = taskId.replace(/[^A-Za-z0-9]/g, "");
  if (sanitized.length >= 8) return sanitized.slice(0, 8);
  const hashSuffix = createHash("sha256").update(taskId).digest("hex");
  return `${sanitized}${hashSuffix}`.slice(0, 8);
}

export function getTaskRuntimeNotesRelativePath(taskId: string): string {
  return `tasks/runtime/${getTaskWorkspaceShortId(taskId)}.md`;
}

export function getTaskSubtaskNotesRelativePath(taskId: string): string {
  return `tasks/subtasks/${getTaskWorkspaceShortId(taskId)}.md`;
}

export function getTaskReadonlySummaryRelativePath(taskId: string): string {
  return `.climpire/runtime/task-run-sheet-${getTaskWorkspaceShortId(taskId)}.md`;
}

function resolveWorktreeRelativePath(worktreePath: string, repoRelativePath: string): string {
  return path.join(worktreePath, ...repoRelativePath.split("/"));
}

export function writeTaskReadonlySummary(worktreePath: string, taskId: string, markdown: string): string {
  const relativePath = getTaskReadonlySummaryRelativePath(taskId);
  const absolutePath = resolveWorktreeRelativePath(worktreePath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, "utf8");
  return relativePath;
}

export function buildTaskWorkspacePromptBlock(input: {
  taskId: string;
  readOnlySummaryPath?: string | null;
}): string {
  const runtimeNotesPath = getTaskRuntimeNotesRelativePath(input.taskId);
  const subtaskNotesPath = getTaskSubtaskNotesRelativePath(input.taskId);
  const readOnlySummaryPath =
    input.readOnlySummaryPath === undefined ? getTaskReadonlySummaryRelativePath(input.taskId) : input.readOnlySummaryPath;
  return [
    "[Task Workspace / 작업 메모 워크스페이스]",
    "- Canonical execution state lives in the task run sheet / DB snapshot. Shared checklist files are not the source of truth / 실행 정본은 task run sheet 및 DB snapshot이며 공유 체크리스트 파일이 정본이 아닙니다",
    `- Plan workspace: ${TASK_WORKSPACE_PLAN_LABEL}`,
    `- Review notes workspace: ${TASK_WORKSPACE_REVIEW_LABEL}`,
    `- Lessons log workspace: ${TASK_WORKSPACE_LESSONS_LABEL}`,
    readOnlySummaryPath ? `- Read-only task summary: ${readOnlySummaryPath}` : "- Read-only task summary: generated only when task run sheet is available",
    `- If local scratch notes are needed, use ${runtimeNotesPath} or ${subtaskNotesPath} only`,
    "- Do not create or update shared todo/review/lessons files as task output / 공유 todo/review/lessons 파일을 작업 산출물로 수정하지 마세요",
  ].join("\n");
}
