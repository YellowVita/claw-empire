import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRunRouteDeps } from "./execution-run.ts";
import { registerTaskRunRoute } from "./execution-run.ts";

type FakeTaskRow = {
  id: string;
  title: string;
  description: string | null;
  assigned_agent_id: string | null;
  department_id: string | null;
  project_id: string | null;
  workflow_pack_key: string | null;
  workflow_meta_json: string | null;
  project_path: string | null;
  status: string;
};

type FakeAgentRow = {
  id: string;
  name: string;
  name_ko: string | null;
  role: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
  personality: string | null;
  department_id: string | null;
  department_name: string | null;
  department_name_ko: string | null;
  department_prompt: string | null;
};

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

const tempDirs: string[] = [];
const originalAllowedRoots = process.env.PROJECT_PATH_ALLOWED_ROOTS;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function resetPathEnv(): void {
  if (originalAllowedRoots === undefined) delete process.env.PROJECT_PATH_ALLOWED_ROOTS;
  else process.env.PROJECT_PATH_ALLOWED_ROOTS = originalAllowedRoots;
}

afterEach(() => {
  resetPathEnv();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHarness(options?: {
  taskOverrides?: Partial<FakeTaskRow>;
  projectPath?: string | null;
}) {
  const routes = new Map<string, (req: any, res: any) => any>();
  const task: FakeTaskRow = {
    id: "task-1",
    title: "Run task",
    description: "Review the project",
    assigned_agent_id: "agent-1",
    department_id: "engineering",
    project_id: null,
    workflow_pack_key: null,
    workflow_meta_json: null,
    project_path: null,
    status: "pending",
    ...(options?.taskOverrides ?? {}),
  };
  const agent: FakeAgentRow = {
    id: "agent-1",
    name: "Tester",
    name_ko: null,
    role: "senior",
    cli_provider: "claude",
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    cli_model: null,
    cli_reasoning_level: null,
    personality: null,
    department_id: "engineering",
    department_name: "Engineering",
    department_name_ko: null,
    department_prompt: null,
  };
  const appendTaskLog = vi.fn();
  const ensureTaskExecutionSession = vi.fn(() => ({
    sessionId: "session-1",
    agentId: agent.id,
    provider: "claude",
  }));
  const createWorktree = vi.fn(() => ({
    success: false as const,
    failureCode: "worktree_add_failed" as const,
    message: "simulated failure",
    projectPath: options?.projectPath ?? task.project_path,
  }));
  const projectPath = options?.projectPath ?? null;

  const db = {
    prepare(sql: string) {
      if (sql.startsWith("SELECT * FROM tasks WHERE id = ?")) {
        return {
          get: () => task,
          run: () => ({ changes: 0 }),
          all: () => [],
        };
      }
      if (sql.startsWith("SELECT current_task_id FROM agents WHERE id = ? AND status = 'working'")) {
        return {
          get: () => undefined,
          run: () => ({ changes: 0 }),
          all: () => [],
        };
      }
      if (sql.startsWith("SELECT project_path FROM projects WHERE id = ?")) {
        return {
          get: () => (task.project_id && projectPath ? { project_path: projectPath } : undefined),
          run: () => ({ changes: 0 }),
          all: () => [],
        };
      }
      if (sql.includes("FROM agents a") || sql.includes("FROM agents a LEFT JOIN departments d")) {
        return {
          get: () => agent,
          run: () => ({ changes: 0 }),
          all: () => [],
        };
      }
      return {
        get: () => undefined,
        run: () => ({ changes: 0 }),
        all: () => [],
      };
    },
  };

  const deps: TaskRunRouteDeps = {
    app: {
      post(routePath: string, handler: (req: any, res: any) => any) {
        routes.set(routePath, handler);
      },
    } as any,
    db: db as any,
    activeProcesses: new Map(),
    appendTaskLog,
    nowMs: () => 1000,
    resolveLang: () => "en",
    ensureTaskExecutionSession,
    logsDir: "C:\\temp\\logs",
    createWorktree,
    generateProjectContext: () => "",
    getRecentChanges: () => "",
    ensureClaudeMd: vi.fn(),
    getDeptRoleConstraint: () => "",
    normalizeTextField: (value: unknown) => {
      if (typeof value !== "string") return null;
      const normalized = value.trim();
      return normalized ? normalized : null;
    },
    getRecentConversationContext: () => "",
    getTaskContinuationContext: () => "",
    pickL: (bundle: Record<string, string>, lang: string) => bundle[lang] ?? bundle.en ?? bundle.ko,
    l: (ko: string[], en: string[], ja: string[] = [], zh: string[] = []) => ({
      ko: ko.join(""),
      en: en.join(""),
      ja: ja.join(""),
      zh: zh.join(""),
    }),
    getProviderModelConfig: () => ({}),
    buildTaskExecutionPrompt: () => "",
    hasExplicitWarningFixRequest: () => false,
    getNextHttpAgentPid: () => 1,
    broadcast: vi.fn(),
    getAgentDisplayName: () => agent.name,
    notifyCeo: vi.fn(),
    startProgressTimer: vi.fn(),
    launchApiProviderAgent: vi.fn(),
    launchHttpAgent: vi.fn(),
    spawnCliAgent: vi.fn(() => ({ pid: 1234, on: vi.fn() })),
    handleTaskRunComplete: vi.fn(),
    buildAvailableSkillsPromptBlock: () => "",
  };

  registerTaskRunRoute(deps);

  return {
    handler: routes.get("/api/tasks/:id/run"),
    appendTaskLog,
    ensureTaskExecutionSession,
    createWorktree,
  };
}

describe("registerTaskRunRoute", () => {
  it("project path가 없으면 missing_project_path를 반환하고 실행 부작용을 만들지 않는다", () => {
    resetPathEnv();
    const harness = createHarness({ taskOverrides: { project_path: null } });
    const res = createFakeResponse();

    harness.handler?.({ params: { id: "task-1" }, body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      error: "missing_project_path",
    });
    expect(harness.ensureTaskExecutionSession).not.toHaveBeenCalled();
    expect(harness.createWorktree).not.toHaveBeenCalled();
    expect(harness.appendTaskLog).not.toHaveBeenCalledWith("task-1", "system", expect.stringContaining("RUN start"));
  });

  it("project path가 있으면 기존 worktree 생성 흐름으로 진행한다", () => {
    resetPathEnv();
    const projectDir = createTempDir("claw-run-project-");
    const harness = createHarness({ taskOverrides: { project_path: projectDir } });
    const res = createFakeResponse();

    harness.handler?.({ params: { id: "task-1" }, body: {} }, res);

    expect(harness.ensureTaskExecutionSession).toHaveBeenCalledTimes(1);
    expect(harness.createWorktree).toHaveBeenCalledWith(projectDir, "task-1", "Tester");
    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({
      error: "worktree_required",
    });
  });

  it("blocks legacy relative task.project_path before creating a session", () => {
    resetPathEnv();
    const harness = createHarness({ taskOverrides: { project_path: "../legacy-relative" } });
    const res = createFakeResponse();

    harness.handler?.({ params: { id: "task-1" }, body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({ error: "relative_project_path_not_allowed" });
    expect(harness.ensureTaskExecutionSession).not.toHaveBeenCalled();
    expect(harness.createWorktree).not.toHaveBeenCalled();
  });

  it("blocks conflicting task and request project paths", () => {
    resetPathEnv();
    const projectDir = createTempDir("claw-run-project-");
    const otherDir = createTempDir("claw-run-other-");
    const harness = createHarness({ taskOverrides: { project_path: projectDir } });
    const res = createFakeResponse();

    harness.handler?.({ params: { id: "task-1" }, body: { project_path: otherDir } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ error: "conflicting_project_path_sources" });
    expect(harness.ensureTaskExecutionSession).not.toHaveBeenCalled();
    expect(harness.createWorktree).not.toHaveBeenCalled();
  });

  it("prefers project_id path and rejects conflicting task.project_path", () => {
    resetPathEnv();
    const projectDir = createTempDir("claw-run-project-");
    const otherDir = createTempDir("claw-run-other-");
    const harness = createHarness({
      taskOverrides: { project_id: "project-1", project_path: otherDir },
      projectPath: projectDir,
    });
    const res = createFakeResponse();

    harness.handler?.({ params: { id: "task-1" }, body: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ error: "conflicting_project_path_sources" });
    expect(harness.ensureTaskExecutionSession).not.toHaveBeenCalled();
    expect(harness.createWorktree).not.toHaveBeenCalled();
  });

  it("git bootstrap disabled면 수동 git 초기화 안내를 반환한다", () => {
    resetPathEnv();
    const projectDir = createTempDir("claw-run-bootstrap-policy-");
    const harness = createHarness({ taskOverrides: { project_path: projectDir } });
    harness.createWorktree.mockReturnValue({
      success: false,
      failureCode: "git_bootstrap_disabled",
      message: "auto bootstrap disabled",
      projectPath: projectDir,
      manualSetupCommands: ['git init', 'git add -A', 'git commit -m "initial commit"'],
    });
    const res = createFakeResponse();

    harness.handler?.({ params: { id: "task-1" }, body: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({
      error: "worktree_required",
      message: expect.stringContaining("git init"),
    });
    expect(harness.appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "error",
      expect.stringContaining("git_bootstrap_disabled"),
    );
  });

  it("rejects a runtime realpath that escapes allowed roots via symlink", () => {
    const allowedRoot = createTempDir("claw-run-allowed-");
    const outsideRoot = createTempDir("claw-run-outside-");
    const linkedPath = path.join(allowedRoot, "linked-project");
    fs.symlinkSync(outsideRoot, linkedPath, "junction");
    process.env.PROJECT_PATH_ALLOWED_ROOTS = allowedRoot;

    const harness = createHarness({ taskOverrides: { project_path: linkedPath } });
    const res = createFakeResponse();

    harness.handler?.({ params: { id: "task-1" }, body: {} }, res);

    expect(res.statusCode).toBe(403);
    expect(res.payload).toMatchObject({ error: "project_path_outside_allowed_roots" });
    expect(harness.ensureTaskExecutionSession).not.toHaveBeenCalled();
    expect(harness.createWorktree).not.toHaveBeenCalled();
  });
});
