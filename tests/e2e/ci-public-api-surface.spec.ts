import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import path from "node:path";
import { cleanupE2EResources } from "./cleanup";

type OpenApiDoc = {
  paths?: Record<string, Record<string, unknown>>;
};

type ProjectCreateResponse = {
  ok: boolean;
  project: {
    id: string;
    project_path: string;
  };
};

type TaskCreateResponse = {
  id?: string;
  task?: {
    id: string;
  };
};

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

async function establishApiSession(request: APIRequestContext): Promise<void> {
  const timeoutMs = 30_000;
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastText = "";

  while (Date.now() - startedAt < timeoutMs) {
    const response = await request.get("/api/auth/session");
    const text = await response.text();
    if (response.ok()) {
      return;
    }
    lastStatus = response.status();
    lastText = text;
    if (lastStatus === 502 || lastStatus === 503 || lastStatus === 404) {
      await sleep(500);
      continue;
    }
    throw new Error(`GET /api/auth/session failed (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
  }

  throw new Error(`GET /api/auth/session timed out (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
}

function expectDocumentedPath(doc: OpenApiDoc, method: string, openApiPath: string): void {
  const operation = doc.paths?.[openApiPath]?.[method.toLowerCase()];
  expect(operation, `${method} ${openApiPath} should be documented in OpenAPI`).toBeTruthy();
}

test.describe("CI public API surface", () => {
  test.setTimeout(180_000);

  test("public-facing utility routes stay callable and documented", async ({ request }) => {
    const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const deptId = `ci_public_dept_${seed}`;
    const agentName = `ci-public-agent-${seed}`;
    const projectPath = path.resolve("test-results", "ci-e2e", "public-surface", seed, "workspace");
    const cleanup = {
      subtaskIds: [] as string[],
      taskIds: [] as string[],
      agentIds: [] as string[],
      departmentIds: [deptId],
      projectIds: [] as string[],
    };

    try {
      await establishApiSession(request);

      const healthRes = await request.get("/api/health");
      const healthJson = await expectOkJson<{ ok?: boolean; version?: string; app?: string }>(
        healthRes,
        "GET /api/health",
      );
      expect(healthJson.ok).toBe(true);
      expect(typeof healthJson.version).toBe("string");

      const docsRes = await request.get("/api/docs");
      expect(docsRes.ok()).toBe(true);

      const swaggerBootstrapRes = await request.get("/api/docs/swagger-bootstrap.js");
      expect(swaggerBootstrapRes.ok()).toBe(true);

      const openApiRes = await request.get("/api/openapi.json");
      const openApiDoc = await expectOkJson<OpenApiDoc>(openApiRes, "GET /api/openapi.json");
      expectDocumentedPath(openApiDoc, "GET", "/api/cli-status");
      expectDocumentedPath(openApiDoc, "GET", "/api/agents/{id}");
      expectDocumentedPath(openApiDoc, "GET", "/api/departments/{id}");
      expectDocumentedPath(openApiDoc, "GET", "/api/projects/{id}");
      expectDocumentedPath(openApiDoc, "GET", "/api/projects/path-browse");
      expectDocumentedPath(openApiDoc, "GET", "/api/subtasks");
      expectDocumentedPath(openApiDoc, "GET", "/api/task-reports");
      expectDocumentedPath(openApiDoc, "GET", "/api/task-reports/{taskId}");

      const cliStatusRes = await request.get("/api/cli-status");
      const cliStatusJson = await expectOkJson<{ providers: unknown[] | Record<string, unknown> }>(
        cliStatusRes,
        "GET /api/cli-status",
      );
      expect(cliStatusJson.providers).toBeTruthy();

      const createDeptRes = await request.post("/api/departments", {
        data: {
          id: deptId,
          name: `CI Public Dept ${seed}`,
          name_ko: `공개API-${seed}`,
          icon: "🧪",
          color: "#2563eb",
        },
      });
      const createDeptJson = await expectOkJson<{ department: { id: string } }>(createDeptRes, "POST /api/departments");
      expect(createDeptJson.department.id).toBe(deptId);

      const deptDetailRes = await request.get(`/api/departments/${deptId}`);
      const deptDetailJson = await expectOkJson<{ department: { id: string } }>(
        deptDetailRes,
        "GET /api/departments/:id",
      );
      expect(deptDetailJson.department.id).toBe(deptId);

      const createAgentRes = await request.post("/api/agents", {
        data: {
          name: agentName,
          name_ko: `에이전트-${seed}`,
          department_id: deptId,
          role: "senior",
          cli_provider: "api",
          avatar_emoji: "🧪",
        },
      });
      const createAgentJson = await expectOkJson<{ ok: boolean; agent: { id: string } }>(
        createAgentRes,
        "POST /api/agents",
      );
      expect(createAgentJson.ok).toBe(true);
      const agentId = createAgentJson.agent.id;
      cleanup.agentIds.push(agentId);

      const agentDetailRes = await request.get(`/api/agents/${agentId}`);
      const agentDetailJson = await expectOkJson<{ agent: { id: string } }>(agentDetailRes, "GET /api/agents/:id");
      expect(agentDetailJson.agent.id).toBe(agentId);

      const createProjectRes = await request.post("/api/projects", {
        data: {
          name: `ci-public-project-${seed}`,
          project_path: projectPath,
          core_goal: "Verify public API utility surface in CI",
        },
      });
      const createProjectJson = await expectOkJson<ProjectCreateResponse>(createProjectRes, "POST /api/projects");
      expect(createProjectJson.ok).toBe(true);
      const projectId = createProjectJson.project.id;
      cleanup.projectIds.push(projectId);

      const pathCheckRes = await request.get(`/api/projects/path-check?path=${encodeURIComponent(projectPath)}`);
      const pathCheckJson = await expectOkJson<{ ok: boolean; normalized_path: string }>(
        pathCheckRes,
        "GET /api/projects/path-check",
      );
      expect(pathCheckJson.normalized_path).toBe(projectPath);

      const pathSuggestionsRes = await request.get(
        `/api/projects/path-suggestions?q=${encodeURIComponent("climpire")}`,
      );
      const pathSuggestionsJson = await expectOkJson<{ ok: boolean; paths: string[] }>(
        pathSuggestionsRes,
        "GET /api/projects/path-suggestions",
      );
      expect(Array.isArray(pathSuggestionsJson.paths)).toBe(true);

      const browseParent = path.dirname(projectPath);
      const pathBrowseRes = await request.get(`/api/projects/path-browse?path=${encodeURIComponent(browseParent)}`);
      const pathBrowseJson = await expectOkJson<{
        ok: boolean;
        current_path: string;
        entries: Array<{ path: string }>;
      }>(pathBrowseRes, "GET /api/projects/path-browse");
      expect(pathBrowseJson.current_path).toBe(browseParent);
      expect(Array.isArray(pathBrowseJson.entries)).toBe(true);

      const projectDetailRes = await request.get(`/api/projects/${projectId}`);
      const projectDetailJson = await expectOkJson<{
        project: { id: string };
        tasks: unknown[];
        reports: unknown[];
        decision_events: unknown[];
      }>(projectDetailRes, "GET /api/projects/:id");
      expect(projectDetailJson.project.id).toBe(projectId);
      expect(Array.isArray(projectDetailJson.tasks)).toBe(true);
      expect(Array.isArray(projectDetailJson.reports)).toBe(true);

      const workflowPacksRes = await request.get("/api/workflow-packs");
      const workflowPacksJson = await expectOkJson<{ packs: Array<{ key: string }> }>(
        workflowPacksRes,
        "GET /api/workflow-packs",
      );
      expect(workflowPacksJson.packs.length).toBeGreaterThan(0);

      const workflowRouteRes = await request.post("/api/workflow/route", {
        data: {
          text: "CI build fix and API surface verification",
          project_id: projectId,
        },
      });
      const workflowRouteJson = await expectOkJson<{ packKey: string; confidence: number }>(
        workflowRouteRes,
        "POST /api/workflow/route",
      );
      expect(typeof workflowRouteJson.packKey).toBe("string");
      expect(typeof workflowRouteJson.confidence).toBe("number");

      const createTaskRes = await request.post("/api/tasks", {
        data: {
          title: `ci-public-task-${seed}`,
          description: "Public API utility coverage",
          priority: 2,
          status: "planned",
          task_type: "general",
          project_id: projectId,
          department_id: deptId,
        },
      });
      const createTaskJson = await expectOkJson<TaskCreateResponse>(createTaskRes, "POST /api/tasks");
      const taskId = createTaskJson.task?.id ?? createTaskJson.id;
      expect(taskId).toBeTruthy();
      cleanup.taskIds.push(taskId ?? "");

      const createSubtaskRes = await request.post(`/api/tasks/${taskId}/subtasks`, {
        data: {
          title: `ci-public-subtask-${seed}`,
          description: "Verify subtask endpoints",
          assigned_agent_id: agentId,
        },
      });
      const createSubtaskJson = await expectOkJson<{ id: string; task_id: string }>(
        createSubtaskRes,
        "POST /api/tasks/:id/subtasks",
      );
      expect(createSubtaskJson.task_id).toBe(taskId);
      cleanup.subtaskIds.push(createSubtaskJson.id);

      const listSubtasksRes = await request.get("/api/subtasks?active=1");
      const listSubtasksJson = await expectOkJson<{ subtasks: Array<{ id: string }> }>(
        listSubtasksRes,
        "GET /api/subtasks?active=1",
      );
      expect(listSubtasksJson.subtasks.some((subtask) => subtask.id === createSubtaskJson.id)).toBe(true);

      const patchSubtaskRes = await request.patch(`/api/subtasks/${createSubtaskJson.id}`, {
        data: {
          status: "done",
          delegated_task_id: taskId,
        },
      });
      const patchSubtaskJson = await expectOkJson<{ id: string; status: string }>(
        patchSubtaskRes,
        "PATCH /api/subtasks/:id",
      );
      expect(patchSubtaskJson.status).toBe("done");

      const completeTaskRes = await request.patch(`/api/tasks/${taskId}`, {
        data: {
          status: "done",
          result: `public-api-result-${seed}`,
        },
      });
      await expectOkJson(completeTaskRes, "PATCH /api/tasks/:id(done)");

      const taskReportsRes = await request.get("/api/task-reports");
      const taskReportsJson = await expectOkJson<{ ok: boolean; reports: Array<{ id: string }> }>(
        taskReportsRes,
        "GET /api/task-reports",
      );
      expect(taskReportsJson.reports.some((report) => report.id === taskId)).toBe(true);

      const taskReportDetailRes = await request.get(`/api/task-reports/${taskId}`);
      const taskReportDetailJson = await expectOkJson<{ ok: boolean; project: { root_task_id: string } }>(
        taskReportDetailRes,
        "GET /api/task-reports/:taskId",
      );
      expect(taskReportDetailJson.project.root_task_id).toBe(taskId);

      const meetingPresenceRes = await request.get("/api/meeting-presence");
      const meetingPresenceJson = await expectOkJson<Record<string, unknown>>(
        meetingPresenceRes,
        "GET /api/meeting-presence",
      );
      expect(typeof meetingPresenceJson).toBe("object");
    } finally {
      await cleanupE2EResources(request, cleanup);
    }
  });
});
