export const ORCHESTRATION_V2_VERSION = 2;
export const ORCHESTRATION_V2_FOREIGN_PARALLELISM = 2;

export const ORCHESTRATION_V2_STAGES = [
  "owner_prep",
  "foreign_collab",
  "owner_integrate",
  "finalize",
  "review",
] as const;

export const ORCHESTRATION_V2_PHASES = [
  "owner_prep",
  "foreign_collab",
  "owner_integrate",
  "finalize",
] as const;

export type OrchestrationV2Stage = (typeof ORCHESTRATION_V2_STAGES)[number];
export type OrchestrationV2Phase = (typeof ORCHESTRATION_V2_PHASES)[number];

type SubtaskLike = {
  title?: string | null;
  target_department_id?: string | null;
  orchestration_phase?: string | null;
  status?: string | null;
};

type TaskLike = {
  orchestration_version?: number | null;
  orchestration_stage?: string | null;
  department_id?: string | null;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isOrchestrationV2Stage(value: unknown): value is OrchestrationV2Stage {
  return ORCHESTRATION_V2_STAGES.includes(value as OrchestrationV2Stage);
}

export function isOrchestrationV2Phase(value: unknown): value is OrchestrationV2Phase {
  return ORCHESTRATION_V2_PHASES.includes(value as OrchestrationV2Phase);
}

export function isTaskOrchestrationV2(task: TaskLike | null | undefined): boolean {
  return Number(task?.orchestration_version ?? 1) >= ORCHESTRATION_V2_VERSION;
}

export function getTaskOrchestrationStage(task: TaskLike | null | undefined): OrchestrationV2Stage | null {
  const raw = normalizeText(task?.orchestration_stage);
  return isOrchestrationV2Stage(raw) ? raw : null;
}

export function inferOrchestrationPhaseFromSubtask(subtask: SubtaskLike | null | undefined): OrchestrationV2Phase {
  const explicit = normalizeText(subtask?.orchestration_phase);
  if (isOrchestrationV2Phase(explicit)) return explicit;

  const title = normalizeText(subtask?.title);
  if (/\[VIDEO_FINAL_RENDER\]/i.test(title)) return "finalize";
  if (/통합|최종 정리|Consolidate department deliverables|finalize package/i.test(title)) {
    return "owner_integrate";
  }
  if (normalizeText(subtask?.target_department_id)) return "foreign_collab";
  return "owner_prep";
}

export type LegacyDelegationReadiness = {
  ready: boolean;
  ownerPrepBlockerCount: number;
  ownerSideOpenCount: number;
  ownerIntegrateOpenCount: number;
};

function isOpenSubtaskStatus(status: unknown): boolean {
  const normalized = normalizeText(status);
  return normalized !== "done" && normalized !== "cancelled";
}

function isOwnerSideSubtask(subtask: SubtaskLike | null | undefined, task: TaskLike | null | undefined): boolean {
  const targetDepartmentId = normalizeText(subtask?.target_department_id);
  const ownerDepartmentId = normalizeText(task?.department_id);
  return !targetDepartmentId || (!!ownerDepartmentId && targetDepartmentId === ownerDepartmentId);
}

export function getLegacyForeignDelegationReadiness(
  task: TaskLike | null | undefined,
  subtasks: Array<SubtaskLike | null | undefined>,
): LegacyDelegationReadiness {
  const ownerSideOpenSubtasks = subtasks.filter(
    (subtask) => isOpenSubtaskStatus(subtask?.status) && isOwnerSideSubtask(subtask, task),
  );
  let ownerPrepBlockerCount = 0;
  let ownerIntegrateOpenCount = 0;

  for (const subtask of ownerSideOpenSubtasks) {
    const phase = inferOrchestrationPhaseFromSubtask(subtask);
    if (phase === "owner_prep") ownerPrepBlockerCount += 1;
    if (phase === "owner_integrate") ownerIntegrateOpenCount += 1;
  }

  return {
    ready: ownerPrepBlockerCount === 0,
    ownerPrepBlockerCount,
    ownerSideOpenCount: ownerSideOpenSubtasks.length,
    ownerIntegrateOpenCount,
  };
}

export function getStagePendingPhases(stage: OrchestrationV2Stage): OrchestrationV2Phase[] {
  switch (stage) {
    case "owner_prep":
      return ["owner_prep"];
    case "foreign_collab":
      return ["foreign_collab"];
    case "owner_integrate":
      return ["owner_integrate"];
    case "finalize":
      return ["finalize"];
    case "review":
      return [];
    default:
      return [];
  }
}

export function buildOwnerIntegrationInstruction(taskTitle: string): string {
  return [
    "[ORCHESTRATION V2]",
    "Current stage: owner_integrate",
    `Task: ${taskTitle}`,
    "Integrate completed department deliverables into the owner worktree.",
    "Read sibling delegated task worktrees as reference only.",
    "Do not re-run foreign department work. Consolidate, resolve conflicts, and prepare the final review package.",
  ].join("\n");
}
