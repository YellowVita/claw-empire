import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import path from "node:path";
import { cleanupE2EResources } from "./cleanup";

type OpenApiDoc = {
  paths?: Record<string, unknown>;
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
      throw new Error(`${label}: JSON 파싱 실패 (status=${response.status()}): ${text.slice(0, 500)}`);
    }
  }
  if (!response.ok()) {
    throw new Error(`${label}: 요청 실패 (status=${response.status()}): ${text.slice(0, 1000)}`);
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
    throw new Error(`GET /api/auth/session 실패 (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
  }

  throw new Error(`GET /api/auth/session 타임아웃 (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
}

test.describe("CI docs and operational API coverage", () => {
  test.setTimeout(180_000);

  test("OpenAPI exposes contributor-facing ops routes and live endpoints respond", async ({ request }) => {
    const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const repoPath = process.cwd();
    const browseParentPath = path.dirname(repoPath);
    const cleanup = {
      taskIds: [] as string[],
      projectIds: [] as string[],
    };

    try {
      await establishApiSession(request);

      const openApiRes = await request.get("/api/openapi.json");
      const openApi = await expectOkJson<OpenApiDoc>(openApiRes, "GET /api/openapi.json");
      const documentedPaths = new Set(Object.keys(openApi.paths ?? {}));
      for (const requiredPath of [
        "/api/meeting-presence",
        "/api/agents/active",
        "/api/agents/cli-processes",
        "/api/agents/cli-processes/{pid}",
        "/api/api-providers/presets",
        "/api/api-providers/{id}/models",
        "/api/api-providers/{id}/test",
        "/api/cli-usage",
        "/api/cli-usage/refresh",
        "/api/projects/{id}",
        "/api/projects/{id}/branches",
        "/api/projects/path-browse",
        "/api/task-reports",
        "/api/task-reports/{taskId}",
        "/api/task-reports/{taskId}/archive",
        "/api/tasks/bulk-hide",
        "/api/tasks/{id}/diff",
        "/api/tasks/{id}/discard",
        "/api/tasks/{id}/merge",
        "/api/worktrees",
      ]) {
        expect(documentedPaths.has(requiredPath), `OpenAPI missing ${requiredPath}`).toBe(true);
      }

      const docsRes = await request.get("/api/docs");
      const docsHtml = await docsRes.text();
      expect(docsRes.ok()).toBe(true);
      expect(docsHtml).toContain('id="swagger-ui"');
      expect(docsHtml).toContain("/api/docs/swagger-bootstrap.js");

      const meetingPresenceRes = await request.get("/api/meeting-presence");
      const meetingPresence = await expectOkJson<{ presence: unknown[] }>(
        meetingPresenceRes,
        "GET /api/meeting-presence",
      );
      expect(Array.isArray(meetingPresence.presence)).toBe(true);

      const activeAgentsRes = await request.get("/api/agents/active");
      const activeAgents = await expectOkJson<{ ok: boolean; agents: unknown[] }>(
        activeAgentsRes,
        "GET /api/agents/active",
      );
      expect(activeAgents.ok).toBe(true);
      expect(Array.isArray(activeAgents.agents)).toBe(true);

      const cliProcessesRes = await request.get("/api/agents/cli-processes");
      const cliProcesses = await expectOkJson<{ ok: boolean; processes: unknown[] }>(
        cliProcessesRes,
        "GET /api/agents/cli-processes",
      );
      expect(cliProcesses.ok).toBe(true);
      expect(Array.isArray(cliProcesses.processes)).toBe(true);

      const providerPresetsRes = await request.get("/api/api-providers/presets");
      const providerPresets = await expectOkJson<{ ok: boolean; presets: Record<string, unknown> }>(
        providerPresetsRes,
        "GET /api/api-providers/presets",
      );
      expect(providerPresets.ok).toBe(true);
      expect(providerPresets.presets).toHaveProperty("openai");

      const cliUsageRes = await request.get("/api/cli-usage");
      const cliUsage = await expectOkJson<{ ok: boolean; usage: Record<string, unknown> }>(
        cliUsageRes,
        "GET /api/cli-usage",
      );
      expect(cliUsage.ok).toBe(true);
      expect(typeof cliUsage.usage).toBe("object");

      const cliUsageRefreshRes = await request.post("/api/cli-usage/refresh");
      const cliUsageRefresh = await expectOkJson<{ ok: boolean; usage: Record<string, unknown> }>(
        cliUsageRefreshRes,
        "POST /api/cli-usage/refresh",
      );
      expect(cliUsageRefresh.ok).toBe(true);
      expect(typeof cliUsageRefresh.usage).toBe("object");

      const pathBrowseRes = await request.get(`/api/projects/path-browse?path=${encodeURIComponent(browseParentPath)}`);
      const pathBrowse = await expectOkJson<{
        ok: boolean;
        current_path: string;
        entries: Array<{ name: string; path: string }>;
      }>(pathBrowseRes, "GET /api/projects/path-browse");
      expect(pathBrowse.ok).toBe(true);
      expect(pathBrowse.current_path).toBe(browseParentPath);
      expect(pathBrowse.entries.some((entry) => entry.path === repoPath)).toBe(true);

      const createProjectRes = await request.post("/api/projects", {
        data: {
          name: `ci-docs-project-${seed}`,
          project_path: repoPath,
          core_goal: "Document and verify contributor-facing ops APIs",
        },
      });
      let projectId = "";
      let projectPath = repoPath;
      if (createProjectRes.ok()) {
        const createdProject = await expectOkJson<{
          ok: boolean;
          project: { id: string; project_path: string };
        }>(createProjectRes, "POST /api/projects");
        expect(createdProject.ok).toBe(true);
        expect(createdProject.project.project_path).toBe(repoPath);
        projectId = createdProject.project.id;
        projectPath = createdProject.project.project_path;
        cleanup.projectIds.push(projectId);
      } else if (createProjectRes.status() === 409) {
        const conflict = await createProjectRes.json();
        projectId = String(conflict.existing_project_id ?? "");
        projectPath = String(conflict.existing_project_path ?? repoPath);
        expect(projectId).toBeTruthy();
        expect(projectPath).toBe(repoPath);
      } else {
        const text = await createProjectRes.text();
        throw new Error(`POST /api/projects 실패 (status=${createProjectRes.status()}): ${text.slice(0, 1000)}`);
      }

      const projectDetailRes = await request.get(`/api/projects/${projectId}`);
      const projectDetail = await expectOkJson<{
        project: { id: string; project_path: string };
        assigned_agents: unknown[];
        tasks: unknown[];
        reports: unknown[];
        decision_events: unknown[];
      }>(projectDetailRes, "GET /api/projects/:id");
      expect(projectDetail.project.id).toBe(projectId);
      expect(projectDetail.project.project_path).toBe(projectPath);
      expect(Array.isArray(projectDetail.assigned_agents)).toBe(true);
      expect(Array.isArray(projectDetail.tasks)).toBe(true);
      expect(Array.isArray(projectDetail.reports)).toBe(true);

      const projectBranchesRes = await request.get(`/api/projects/${projectId}/branches`);
      const projectBranches = await expectOkJson<{ branches: string[]; current_branch: string | null }>(
        projectBranchesRes,
        "GET /api/projects/:id/branches",
      );
      expect(projectBranches.branches.length).toBeGreaterThan(0);
      expect(projectBranches.current_branch).toBeTruthy();
      expect(projectBranches.branches).toContain(projectBranches.current_branch as string);

      const createTaskRes = await request.post("/api/tasks", {
        data: {
          title: `ci-docs-task-${seed}`,
          department_id: "planning",
          project_id: projectId,
          status: "inbox",
        },
      });
      const createdTask = await expectOkJson<{ id: string; task: { id: string; hidden?: number } }>(
        createTaskRes,
        "POST /api/tasks",
      );
      const taskId = createdTask.id;
      cleanup.taskIds.push(taskId);

      const bulkHideRes = await request.post("/api/tasks/bulk-hide", {
        data: {
          statuses: ["inbox"],
          hidden: 1,
        },
      });
      const bulkHide = await expectOkJson<{ ok: boolean; affected: number }>(bulkHideRes, "POST /api/tasks/bulk-hide");
      expect(bulkHide.ok).toBe(true);
      expect(bulkHide.affected).toBeGreaterThan(0);

      const taskDetailRes = await request.get(`/api/tasks/${taskId}`);
      const taskDetail = await expectOkJson<{ task: { id: string; hidden: number } }>(
        taskDetailRes,
        "GET /api/tasks/:id",
      );
      expect(taskDetail.task.hidden).toBe(1);

      const diffRes = await request.get(`/api/tasks/${taskId}/diff`);
      const diff = await expectOkJson<{ ok: boolean; hasWorktree: boolean; diff: string; stat: string }>(
        diffRes,
        "GET /api/tasks/:id/diff",
      );
      expect(diff.ok).toBe(true);
      expect(diff.hasWorktree).toBe(false);
      expect(diff.diff).toBe("");
      expect(diff.stat).toBe("");

      const worktreesRes = await request.get("/api/worktrees");
      const worktrees = await expectOkJson<{ ok: boolean; worktrees: unknown[] }>(worktreesRes, "GET /api/worktrees");
      expect(worktrees.ok).toBe(true);
      expect(Array.isArray(worktrees.worktrees)).toBe(true);
    } finally {
      await cleanupE2EResources(request, cleanup);
    }
  });
});
