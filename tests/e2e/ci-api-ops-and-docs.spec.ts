import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import path from "node:path";

type AgentResponse = {
  ok: boolean;
  agent: {
    id: string;
    status?: string;
  };
};

type TaskResponse = {
  id?: string;
  ok?: boolean;
  task: {
    id: string;
    status: string;
    assigned_agent_id: string | null;
  };
};

type InterruptProof = {
  session_id: string;
  control_token: string;
  requires_csrf: boolean;
};

type TaskSummary = {
  id: string;
  title: string;
  status: string;
  project_id?: string | null;
};

const E2E_INBOX_WEBHOOK_SECRET = "claw-e2e-inbox-secret";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function expectOkJson<T>(response: APIResponse, label: string): Promise<T> {
  const text = await response.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${label}: JSON parse failed (status=${response.status()}): ${text.slice(0, 500)}`);
    }
  }
  if (!response.ok()) {
    throw new Error(`${label}: request failed (status=${response.status()}): ${text.slice(0, 1000)}`);
  }
  return parsed as T;
}

async function establishApiSession(request: APIRequestContext): Promise<string> {
  const timeoutMs = 30_000;
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastText = "";

  while (Date.now() - startedAt < timeoutMs) {
    const response = await request.get("/api/auth/session");
    const text = await response.text();
    if (response.ok()) {
      try {
        const parsed = JSON.parse(text) as { csrf_token?: string };
        if (typeof parsed.csrf_token === "string" && parsed.csrf_token.trim()) {
          return parsed.csrf_token;
        }
      } catch {
        // fall through to explicit error below
      }
      throw new Error("GET /api/auth/session did not return csrf_token");
    }
    lastStatus = response.status();
    lastText = text;
    if (lastStatus === 404 || lastStatus === 502 || lastStatus === 503) {
      await sleep(500);
      continue;
    }
    throw new Error(`GET /api/auth/session failed (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
  }

  throw new Error(`GET /api/auth/session timed out (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
}

async function waitForTask(
  request: APIRequestContext,
  predicate: (task: TaskSummary) => boolean,
  timeoutMs: number,
): Promise<TaskSummary> {
  const startedAt = Date.now();
  let lastTasks: TaskSummary[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const tasksRes = await request.get("/api/tasks");
    const tasksJson = await expectOkJson<{ tasks: TaskSummary[] }>(tasksRes, "GET /api/tasks");
    lastTasks = Array.isArray(tasksJson.tasks) ? tasksJson.tasks : [];
    const found = lastTasks.find(predicate);
    if (found) return found;
    await sleep(350);
  }

  throw new Error(
    `Task predicate was not satisfied. Recent tasks=${lastTasks
      .slice(0, 10)
      .map((task) => `${task.id}:${task.title}:${task.status}`)
      .join(" | ")}`,
  );
}

async function waitForTerminalMarker(
  request: APIRequestContext,
  taskId: string,
  marker: string,
  timeoutMs: number,
): Promise<{ text: string; task_logs?: Array<{ message?: string }> }> {
  const startedAt = Date.now();
  let lastText = "";

  while (Date.now() - startedAt < timeoutMs) {
    const terminalRes = await request.get(`/api/tasks/${taskId}/terminal?lines=200&log_limit=50`);
    const terminal = await expectOkJson<{ text: string; task_logs?: Array<{ message?: string }> }>(
      terminalRes,
      "GET /api/tasks/:id/terminal(after run)",
    );
    lastText = terminal.text ?? "";
    const joinedLogs = (terminal.task_logs ?? []).map((entry) => entry.message ?? "").join("\n");
    if (lastText.includes(marker) || joinedLogs.includes(marker)) {
      return terminal;
    }
    await sleep(350);
  }

  throw new Error(`Terminal marker '${marker}' not observed. Last terminal text=${lastText.slice(0, 500)}`);
}

test.describe("CI API ops and docs coverage", () => {
  test.setTimeout(120_000);

  test("pause + inject + resume flow exposes interrupt control contract", async ({ request }) => {
    const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const deptId = `ci_pause_dept_${seed}`;

    const csrfToken = await establishApiSession(request);

    await expectOkJson(
      await request.post("/api/departments", {
        data: {
          id: deptId,
          name: `Pause Dept ${seed}`,
          icon: "P",
          color: "#2563eb",
        },
      }),
      "POST /api/departments",
    );

    const agent = await expectOkJson<AgentResponse>(
      await request.post("/api/agents", {
        data: {
          name: `pause-agent-${seed}`,
          department_id: deptId,
          role: "senior",
          cli_provider: "api",
          avatar_emoji: "P",
        },
      }),
      "POST /api/agents",
    );
    const agentId = agent.agent.id;

    const task = await expectOkJson<TaskResponse>(
      await request.post("/api/tasks", {
        data: {
          title: `pause-task-${seed}`,
          department_id: deptId,
          assigned_agent_id: agentId,
          status: "planned",
        },
      }),
      "POST /api/tasks",
    );
    const taskId = task.id ?? task.task.id;

    const terminalBeforePause = await expectOkJson<{
      ok: boolean;
      interrupt: InterruptProof | null;
    }>(await request.get(`/api/tasks/${taskId}/terminal?lines=50`), "GET /api/tasks/:id/terminal (before pause)");
    expect(terminalBeforePause.ok).toBe(true);
    expect(terminalBeforePause.interrupt).not.toBeNull();

    const interruptProof = terminalBeforePause.interrupt as InterruptProof;
    expect(interruptProof.session_id.length).toBeGreaterThan(0);
    expect(interruptProof.control_token.length).toBeGreaterThan(0);
    expect(interruptProof.requires_csrf).toBe(true);

    const pauseRes = await expectOkJson<{
      ok: boolean;
      status: string;
      interrupt: InterruptProof | null;
    }>(
      await request.post(`/api/tasks/${taskId}/stop`, {
        data: {
          mode: "pause",
          session_id: interruptProof.session_id,
          interrupt_token: interruptProof.control_token,
        },
        headers: {
          "x-csrf-token": csrfToken,
        },
      }),
      "POST /api/tasks/:id/stop",
    );
    expect(pauseRes.ok).toBe(true);
    expect(pauseRes.status).toBe("pending");
    expect(pauseRes.interrupt?.session_id).toBe(interruptProof.session_id);

    const injectRes = await expectOkJson<{
      ok: boolean;
      queued: boolean;
      session_id: string;
      pending_count: number;
    }>(
      await request.post(`/api/tasks/${taskId}/inject`, {
        data: {
          prompt: "Summarize the latest state before resuming.",
          session_id: interruptProof.session_id,
          interrupt_token: interruptProof.control_token,
        },
        headers: {
          "x-csrf-token": csrfToken,
        },
      }),
      "POST /api/tasks/:id/inject",
    );
    expect(injectRes.ok).toBe(true);
    expect(injectRes.queued).toBe(true);
    expect(injectRes.session_id).toBe(interruptProof.session_id);
    expect(injectRes.pending_count).toBeGreaterThan(0);

    const minutesRes = await expectOkJson<{ meetings: unknown[] }>(
      await request.get(`/api/tasks/${taskId}/meeting-minutes`),
      "GET /api/tasks/:id/meeting-minutes",
    );
    expect(Array.isArray(minutesRes.meetings)).toBe(true);

    await expectOkJson(
      await request.patch(`/api/agents/${agentId}`, {
        data: {
          status: "offline",
        },
      }),
      "PATCH /api/agents/:id(status=offline)",
    );

    const resumeRes = await expectOkJson<{
      ok: boolean;
      status: string;
      auto_resumed: boolean;
    }>(
      await request.post(`/api/tasks/${taskId}/resume`, {
        data: {
          session_id: interruptProof.session_id,
          interrupt_token: interruptProof.control_token,
        },
        headers: {
          "x-csrf-token": csrfToken,
        },
      }),
      "POST /api/tasks/:id/resume",
    );
    expect(resumeRes.ok).toBe(true);
    expect(resumeRes.status).toBe("planned");
    expect(resumeRes.auto_resumed).toBe(false);

    const taskAfterResume = await expectOkJson<TaskResponse>(
      await request.get(`/api/tasks/${taskId}`),
      "GET /api/tasks/:id",
    );
    expect(taskAfterResume.task.status).toBe("planned");
    expect(taskAfterResume.task.assigned_agent_id).toBe(agentId);
  });

  test("project path helpers + api provider CRUD + ops diagnostics are reachable in CI", async ({ request }) => {
    const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const projectsRoot = path.resolve("..");
    const repoName = path.basename(process.cwd());
    const candidateProjectPath = path.join(projectsRoot, "climpire-ci-path-check", seed);

    await establishApiSession(request);

    const cliStatus = await expectOkJson<{ providers: Record<string, unknown> }>(
      await request.get("/api/cli-status?refresh=1"),
      "GET /api/cli-status",
    );
    expect(typeof cliStatus.providers).toBe("object");

    const cliUsage = await expectOkJson<{ ok: boolean; usage: Record<string, unknown> }>(
      await request.get("/api/cli-usage"),
      "GET /api/cli-usage",
    );
    expect(cliUsage.ok).toBe(true);
    expect(typeof cliUsage.usage).toBe("object");

    const pathCheck = await expectOkJson<{
      ok: boolean;
      normalized_path: string;
      can_create: boolean;
    }>(
      await request.get(`/api/projects/path-check?path=${encodeURIComponent(candidateProjectPath)}`),
      "GET /api/projects/path-check",
    );
    expect(pathCheck.ok).toBe(true);
    expect(pathCheck.normalized_path).toBe(candidateProjectPath);
    expect(typeof pathCheck.can_create).toBe("boolean");

    const pathSuggestions = await expectOkJson<{ ok: boolean; paths: string[] }>(
      await request.get(`/api/projects/path-suggestions?q=${encodeURIComponent(repoName)}&limit=10`),
      "GET /api/projects/path-suggestions",
    );
    expect(pathSuggestions.ok).toBe(true);
    expect(Array.isArray(pathSuggestions.paths)).toBe(true);
    expect(pathSuggestions.paths.length).toBeLessThanOrEqual(10);
    expect(pathSuggestions.paths.every((entry) => path.isAbsolute(entry))).toBe(true);

    const pathBrowse = await expectOkJson<{
      ok: boolean;
      current_path: string;
      entries: Array<{ name: string; path: string }>;
    }>(
      await request.get(`/api/projects/path-browse?path=${encodeURIComponent(projectsRoot)}`),
      "GET /api/projects/path-browse",
    );
    expect(pathBrowse.ok).toBe(true);
    expect(pathBrowse.current_path).toBe(projectsRoot);
    expect(pathBrowse.entries.some((entry) => entry.name === repoName)).toBe(true);

    const presets = await expectOkJson<{
      ok: boolean;
      presets: Record<string, { base_url: string; models_path: string }>;
    }>(await request.get("/api/api-providers/presets"), "GET /api/api-providers/presets");
    expect(presets.ok).toBe(true);
    expect(presets.presets.openai?.base_url).toContain("openai");

    const createProvider = await expectOkJson<{ ok: boolean; id: string }>(
      await request.post("/api/api-providers", {
        data: {
          name: `ci-provider-${seed}`,
          type: "openai",
          base_url: "https://example.invalid/v1",
          api_key: "ci-test-key",
        },
      }),
      "POST /api/api-providers",
    );
    expect(createProvider.ok).toBe(true);

    const listProviders = await expectOkJson<{
      ok: boolean;
      providers: Array<{ id: string; name: string; enabled: boolean }>;
    }>(await request.get("/api/api-providers"), "GET /api/api-providers");
    expect(listProviders.ok).toBe(true);
    expect(listProviders.providers.some((provider) => provider.id === createProvider.id)).toBe(true);

    await expectOkJson(
      await request.put(`/api/api-providers/${createProvider.id}`, {
        data: {
          enabled: false,
        },
      }),
      "PUT /api/api-providers/:id",
    );

    const listProvidersAfterUpdate = await expectOkJson<{
      ok: boolean;
      providers: Array<{ id: string; enabled: boolean }>;
    }>(await request.get("/api/api-providers"), "GET /api/api-providers(after update)");
    expect(listProvidersAfterUpdate.providers.find((provider) => provider.id === createProvider.id)?.enabled).toBe(
      false,
    );

    await expectOkJson(
      await request.delete(`/api/api-providers/${createProvider.id}`),
      "DELETE /api/api-providers/:id",
    );
  });

  test("task run route and inbox directive webhook stay callable in CI", async ({ request }) => {
    const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const repoPath = process.cwd();
    const deptId = `ci_run_dept_${seed}`;
    const taskTitle = `ci-run-task-${seed}`;
    const directiveTitle = `ci-inbox-directive-${seed}`;
    await establishApiSession(request);

    const provider = await expectOkJson<{ ok: boolean; id: string }>(
      await request.post("/api/api-providers", {
        data: {
          name: `ci-run-provider-${seed}`,
          type: "openai",
          base_url: "http://127.0.0.1:9/v1",
          api_key: "ci-test-key",
          enabled: true,
          models_cache: JSON.stringify(["ci-test-model"]),
        },
      }),
      "POST /api/api-providers(run)",
    );

    await expectOkJson(
      await request.post("/api/departments", {
        data: {
          id: deptId,
          name: `Run Dept ${seed}`,
          icon: "R",
          color: "#0891b2",
        },
      }),
      "POST /api/departments(run)",
    );

    const agent = await expectOkJson<AgentResponse>(
      await request.post("/api/agents", {
        data: {
          name: `run-agent-${seed}`,
          department_id: deptId,
          role: "team_leader",
          cli_provider: "api",
          api_provider_id: provider.id,
          api_model: "ci-test-model",
          avatar_emoji: "R",
        },
      }),
      "POST /api/agents(run)",
    );
    const agentId = agent.agent.id;

    const createProjectRes = await request.post("/api/projects", {
      data: {
        name: `ci-run-project-${seed}`,
        project_path: repoPath,
        core_goal: "Verify task run route and inbox webhook in CI",
      },
    });
    let projectId = "";
    if (createProjectRes.ok()) {
      const project = await expectOkJson<{ ok: boolean; project: { id: string } }>(
        createProjectRes,
        "POST /api/projects(run)",
      );
      projectId = project.project.id;
    } else if (createProjectRes.status() === 409) {
      const conflict = await createProjectRes.json();
      projectId = String(conflict.existing_project_id ?? "");
      expect(projectId).toBeTruthy();
    } else {
      const text = await createProjectRes.text();
      throw new Error(`POST /api/projects(run) failed (status=${createProjectRes.status()}): ${text.slice(0, 1000)}`);
    }

    const task = await expectOkJson<TaskResponse>(
      await request.post("/api/tasks", {
        data: {
          title: taskTitle,
          department_id: deptId,
          assigned_agent_id: agentId,
          project_id: projectId,
          project_path: repoPath,
          status: "planned",
        },
      }),
      "POST /api/tasks(run)",
    );
    const taskId = task.id ?? task.task.id;

    const runRes = await expectOkJson<{ ok: boolean; pid: number; cwd: string; worktree: boolean }>(
      await request.post(`/api/tasks/${taskId}/run`),
      "POST /api/tasks/:id/run",
    );
    expect(runRes.ok).toBe(true);
    expect(Number.isInteger(runRes.pid)).toBe(true);
    expect(runRes.pid).not.toBe(0);
    expect(runRes.worktree).toBe(true);
    expect(runRes.cwd).toContain(`${path.sep}.climpire-worktrees${path.sep}`);

    const terminalAfterRun = await waitForTerminalMarker(request, taskId, "RUN start", 20_000);
    expect(
      terminalAfterRun.text.includes("RUN start") ||
        (terminalAfterRun.task_logs ?? []).some((entry) => (entry.message ?? "").includes("RUN start")),
    ).toBe(true);

    const inboxRes = await expectOkJson<{ ok: boolean; directive: boolean; routed: string }>(
      await request.post("/api/inbox", {
        data: {
          source: "telegram",
          text: `$${directiveTitle} @${deptId}`,
          author: "CI",
          project_id: projectId,
          project_path: repoPath,
          project_context: "Verify inbox directive webhook in CI",
          skipPlannedMeeting: true,
        },
        headers: {
          "x-inbox-secret": E2E_INBOX_WEBHOOK_SECRET,
        },
      }),
      "POST /api/inbox",
    );
    expect(inboxRes.ok).toBe(true);
    expect(inboxRes.directive).toBe(true);
    expect(inboxRes.routed).toBe("announcement");

    const inboxTask = await waitForTask(request, (candidate) => candidate.title.includes(directiveTitle), 20_000);
    expect(inboxTask.project_id).toBe(projectId);
  });

  test("swagger bootstrap and openapi contract expose CI-critical paths", async ({ request }) => {
    await establishApiSession(request);

    const swaggerBootstrap = await request.get("/api/docs/swagger-bootstrap.js");
    expect(swaggerBootstrap.ok()).toBe(true);
    await expect(swaggerBootstrap.text()).resolves.toContain("/api/auth/session");

    const swaggerUi = await request.get("/api/docs");
    expect(swaggerUi.ok()).toBe(true);
    await expect(swaggerUi.text()).resolves.toContain("Claw-Empire API Docs");

    const openapi = await expectOkJson<{
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    }>(await request.get("/api/openapi.json"), "GET /api/openapi.json");
    expect(openapi.openapi).toBe("3.0.3");

    const requiredPaths = [
      "/api/docs",
      "/api/docs/swagger-bootstrap.js",
      "/api/cli-status",
      "/api/cli-usage",
      "/api/api-providers",
      "/api/api-providers/presets",
      "/api/announcements",
      "/api/agents/{id}/spawn",
      "/api/directives",
      "/api/github/status",
      "/api/github/repos",
      "/api/github/clone",
      "/api/oauth/status",
      "/api/oauth/disconnect",
      "/api/oauth/refresh",
      "/api/oauth/accounts/activate",
      "/api/oauth/accounts/{id}",
      "/api/projects/{id}",
      "/api/projects/path-check",
      "/api/projects/path-suggestions",
      "/api/projects/path-browse",
      "/api/skills",
      "/api/skills/detail",
      "/api/skills/learn",
      "/api/skills/learn/{jobId}",
      "/api/skills/history",
      "/api/skills/unlearn",
      "/api/skills/custom",
      "/api/sprites/process",
      "/api/sprites/register",
      "/api/subtasks",
      "/api/subtasks/{id}",
      "/api/update-auto-status",
      "/api/update-apply",
      "/api/update-auto-config",
      "/api/tasks/{id}/assign",
      "/api/tasks/{id}/inject",
      "/api/tasks/{id}/resume",
      "/api/tasks/{id}/run",
      "/api/tasks/{id}/terminal",
      "/api/tasks/{id}/meeting-minutes",
    ];

    for (const routePath of requiredPaths) {
      expect(openapi.paths[routePath], `missing ${routePath} in openapi`).toBeDefined();
    }
  });
});
