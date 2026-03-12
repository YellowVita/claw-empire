import type { RuntimeContext, WorkflowAgentExports } from "../../types/runtime-context.ts";
import { initializeWorkflowAgentProviders } from "./agents/providers.ts";
import { createSubtaskRoutingTools } from "./agents/subtask-routing.ts";
import { createSubtaskSeedingTools } from "./agents/subtask-seeding.ts";
import { createCliRuntimeTools } from "./agents/cli-runtime.ts";

export function initializeWorkflowPartB(ctx: RuntimeContext): WorkflowAgentExports {
  const __ctx: RuntimeContext = ctx;

  const db = __ctx.db;
  const nowMs = __ctx.nowMs;
  const logsDir = __ctx.logsDir;
  const activeProcesses = __ctx.activeProcesses;
  const appendTaskLog = __ctx.appendTaskLog;
  const broadcast = __ctx.broadcast;
  const runAgentOneShot = __ctx.runAgentOneShot;
  const resolveProjectPath = (...args: any[]) => __ctx.resolveProjectPath(...args);
  const resolveLang = (...args: any[]) => __ctx.resolveLang(...args);
  const findTeamLeader = (...args: any[]) => __ctx.findTeamLeader(...args);
  const getDeptName = (...args: any[]) => __ctx.getDeptName(...args);
  const getPreferredLanguage = (...args: any[]) => __ctx.getPreferredLanguage(...args);
  const l = (...args: any[]) => __ctx.l(...args);
  const pickL = (...args: any[]) => __ctx.pickL(...args);
  const notifyCeo = (...args: any[]) => __ctx.notifyCeo(...args);
  const detectTargetDepartments = (...args: any[]) => __ctx.detectTargetDepartments(...args);
  const DEPT_KEYWORDS = __ctx.DEPT_KEYWORDS;
  const clearCliOutputDedup = __ctx.clearCliOutputDedup;
  const normalizeStreamChunk = __ctx.normalizeStreamChunk;
  const shouldSkipDuplicateCliOutput = __ctx.shouldSkipDuplicateCliOutput;
  const TASK_RUN_IDLE_TIMEOUT_MS = __ctx.TASK_RUN_IDLE_TIMEOUT_MS;
  const TASK_RUN_HARD_TIMEOUT_MS = __ctx.TASK_RUN_HARD_TIMEOUT_MS;
  const killPidTree = __ctx.killPidTree;
  const buildAgentArgs = __ctx.buildAgentArgs;

  const { analyzeSubtaskDepartment, repairExplicitRoleSubtaskRouting, rerouteSubtasksByPlanningLeader } =
    createSubtaskRoutingTools({
      db,
      DEPT_KEYWORDS,
      detectTargetDepartments,
      runAgentOneShot,
      resolveProjectPath,
    resolveLang,
    findTeamLeader,
    getDeptName,
    pickL,
    l,
    broadcast,
    appendTaskLog,
    notifyCeo,
  });

  const { createSubtaskFromCli, completeSubtaskFromCli, seedApprovedPlanSubtasks, seedReviewRevisionSubtasks } =
    createSubtaskSeedingTools({
      db,
      nowMs,
      broadcast,
      analyzeSubtaskDepartment,
      rerouteSubtasksByPlanningLeader,
      findTeamLeader,
      getDeptName,
      getPreferredLanguage,
      resolveLang,
      l,
      pickL,
      appendTaskLog,
      notifyCeo,
    });

  const { codexThreadToSubtask, spawnCliAgent } = createCliRuntimeTools({
    db,
    logsDir,
    buildAgentArgs,
    clearCliOutputDedup,
    normalizeStreamChunk,
    shouldSkipDuplicateCliOutput,
    broadcast,
    TASK_RUN_IDLE_TIMEOUT_MS,
    TASK_RUN_HARD_TIMEOUT_MS,
    killPidTree,
    appendTaskLog,
    activeProcesses,
    createSubtaskFromCli,
    completeSubtaskFromCli,
  });

  const workflowAgentProviders = initializeWorkflowAgentProviders(
    Object.assign(Object.create(__ctx), {
      createSubtaskFromCli,
      completeSubtaskFromCli,
      spawnCliAgent,
    }),
  );
  const {
    httpAgentCounter,
    getNextHttpAgentPid,
    cachedModels,
    MODELS_CACHE_TTL,
    normalizeOAuthProvider,
    getNextOAuthLabel,
    getOAuthAccounts,
    getPreferredOAuthAccounts,
    getDecryptedOAuthToken,
    getProviderModelConfig,
    refreshGoogleToken,
    exchangeCopilotToken,
    executeCopilotAgent,
    executeAntigravityAgent,
    executeApiProviderAgent,
    launchApiProviderAgent,
    launchHttpAgent,
    killPidTree: killPidTreeFromProvider,
    isPidAlive,
    interruptPidTree,
    appendTaskLog: appendTaskLogFromProvider,
    cachedCliStatus,
    CLI_STATUS_TTL,
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    CLI_TOOLS,
    execWithTimeout,
    detectAllCli,
  } = workflowAgentProviders;

  Object.assign(__ctx, {
    rerouteSubtasksByPlanningLeader,
    repairExplicitRoleSubtaskRouting,
    createSubtaskFromCli,
    completeSubtaskFromCli,
  });

  return {
    analyzeSubtaskDepartment,
    repairExplicitRoleSubtaskRouting,
    seedApprovedPlanSubtasks,
    seedReviewRevisionSubtasks,
    codexThreadToSubtask,
    spawnCliAgent,
    httpAgentCounter,
    getNextHttpAgentPid,
    cachedModels,
    MODELS_CACHE_TTL,
    normalizeOAuthProvider,
    getNextOAuthLabel,
    getOAuthAccounts,
    getPreferredOAuthAccounts,
    getDecryptedOAuthToken,
    getProviderModelConfig,
    refreshGoogleToken,
    exchangeCopilotToken,
    executeCopilotAgent,
    executeAntigravityAgent,
    executeApiProviderAgent,
    launchApiProviderAgent,
    launchHttpAgent,
    killPidTree: killPidTreeFromProvider,
    isPidAlive,
    interruptPidTree,
    appendTaskLog: appendTaskLogFromProvider,
    cachedCliStatus,
    CLI_STATUS_TTL,
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    CLI_TOOLS,
    execWithTimeout,
    detectAllCli,
  };
}
