import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { decryptSecret } from "../../../oauth/helpers.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { createProjectPathPolicy } from "./projects/path-policy.ts";

export type GitHubRouteDeps = Pick<RuntimeContext, "app" | "db" | "broadcast" | "normalizeTextField">;

const GIT_ASKPASS_USERNAME = "x-access-token";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSensitiveFragments(token: string): string[] {
  const trimmed = token.trim();
  if (!trimmed) return [];
  return [
    trimmed,
    `token ${trimmed}`,
    `Bearer ${trimmed}`,
    `bearer ${trimmed}`,
    Buffer.from(`${GIT_ASKPASS_USERNAME}:${trimmed}`).toString("base64"),
  ];
}

function redactSensitiveText(rawText: string, token: string | null | undefined): string {
  let sanitized = String(rawText ?? "");
  sanitized = sanitized.replace(/https:\/\/[^@\s]+@github\.com/gi, "https://***@github.com");
  sanitized = sanitized.replace(/(authorization:\s*(?:token|bearer|basic)\s+)[^\s"']+/gi, "$1***");

  for (const fragment of buildSensitiveFragments(token ?? "")) {
    if (!fragment) continue;
    sanitized = sanitized.replace(new RegExp(escapeRegExp(fragment), "gi"), "***");
  }

  return sanitized;
}

function summarizeGitFailure(rawText: string, token: string | null | undefined, fallback: string): string {
  const sanitized = redactSensitiveText(rawText, token)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return sanitized.at(-1) ?? fallback;
}

function resolvePathForScopeCompare(value: string): string {
  const resolved = path.resolve(path.normalize(value));
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function writeAskpassHelper(token: string): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-empire-git-askpass-"));
  const helperPath = path.join(helperDir, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
  const helperSource =
    process.platform === "win32"
      ? [
          "@echo off",
          "set PROMPT=%~1",
          'echo %PROMPT% | findstr /I "Username" >nul',
          "if not errorlevel 1 (",
          `  echo %CLAW_GIT_ASKPASS_USERNAME%`,
          "  exit /b 0",
          ")",
          "echo %CLAW_GIT_ASKPASS_TOKEN%",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'case "$1" in',
          '  *Username*) printf "%s\\n" "$CLAW_GIT_ASKPASS_USERNAME" ;;',
          '  *) printf "%s\\n" "$CLAW_GIT_ASKPASS_TOKEN" ;;',
          "esac",
          "",
        ].join("\n");

  fs.writeFileSync(helperPath, helperSource, { mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(helperPath, 0o700);
  }

  return {
    env: {
      ...process.env,
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: helperPath,
      GIT_TERMINAL_PROMPT: "0",
      CLAW_GIT_ASKPASS_USERNAME: GIT_ASKPASS_USERNAME,
      CLAW_GIT_ASKPASS_TOKEN: token,
    },
    cleanup: () => {
      fs.rmSync(helperDir, { recursive: true, force: true });
    },
  };
}

function findNearestExistingDirectory(targetPath: string): string | null {
  let probe = path.resolve(targetPath);
  while (probe && probe !== path.dirname(probe)) {
    try {
      if (fs.statSync(probe).isDirectory()) {
        return probe;
      }
    } catch {
      // keep walking up
    }
    probe = path.dirname(probe);
  }

  try {
    if (probe && fs.statSync(probe).isDirectory()) {
      return probe;
    }
  } catch {
    // ignore
  }

  return null;
}

function listDirectoryEntries(targetPath: string): string[] {
  try {
    return fs.readdirSync(targetPath);
  } catch {
    return [];
  }
}

export function registerGitHubRoutes(deps: GitHubRouteDeps): void {
  const { app, db, broadcast, normalizeTextField } = deps;
  const { PROJECT_PATH_ALLOWED_ROOTS, isRelativeProjectPathInput, normalizeProjectPathInput, getContainingAllowedRoot } =
    createProjectPathPolicy({ normalizeTextField });

  function getGitHubAccessToken(): string | null {
    const row = db
      .prepare(
        "SELECT access_token_enc, scope FROM oauth_accounts WHERE provider = 'github' AND status = 'active' ORDER BY priority ASC, updated_at DESC LIMIT 1",
      )
      .get() as { access_token_enc: string | null; scope: string | null } | undefined;
    if (!row?.access_token_enc) return null;
    try {
      return decryptSecret(row.access_token_enc);
    } catch {
      return null;
    }
  }

  function hasRepoScope(scope: string | null | undefined): boolean {
    if (!scope) return false;
    if (scope.includes("github-app")) return true;
    return scope.split(/[\s,]+/).includes("repo");
  }

  const activeClones = new Map<
    string,
    { status: string; progress: number; error?: string; targetPath: string; repoFullName: string }
  >();

  function validateCloneTargetPath(
    rawTargetPath: unknown,
    repoName: string,
  ):
    | { ok: true; targetPath: string; alreadyExists: boolean }
    | { ok: false; status: number; payload: Record<string, unknown> } {
    const defaultTarget = path.join(os.homedir(), "Projects", repoName);
    const normalizedTarget = normalizeProjectPathInput(rawTargetPath ?? defaultTarget);
    if (!normalizedTarget) {
      const error = isRelativeProjectPathInput(rawTargetPath) ? "relative_project_path_not_allowed" : "project_path_required";
      return { ok: false, status: 400, payload: { error } };
    }

    const containingRoot = getContainingAllowedRoot(normalizedTarget);
    if (PROJECT_PATH_ALLOWED_ROOTS.length > 0 && !containingRoot) {
      return {
        ok: false,
        status: 403,
        payload: { error: "project_path_outside_allowed_roots", allowed_roots: PROJECT_PATH_ALLOWED_ROOTS },
      };
    }

    const nearestExistingParent = findNearestExistingDirectory(normalizedTarget);
    if (nearestExistingParent && containingRoot) {
      let realParent = resolvePathForScopeCompare(nearestExistingParent);
      let realRoot = resolvePathForScopeCompare(containingRoot);
      try {
        realParent = resolvePathForScopeCompare(fs.realpathSync(nearestExistingParent));
      } catch {
        // keep normalized path
      }
      try {
        realRoot = resolvePathForScopeCompare(fs.realpathSync(containingRoot));
      } catch {
        // keep normalized path
      }

      const parentRelative = path.relative(realRoot, realParent);
      if (parentRelative && (parentRelative.startsWith("..") || path.isAbsolute(parentRelative))) {
        return {
          ok: false,
          status: 403,
          payload: { error: "project_path_outside_allowed_roots", allowed_roots: PROJECT_PATH_ALLOWED_ROOTS },
        };
      }
    }

    try {
      const stat = fs.lstatSync(normalizedTarget);
      if (!stat.isDirectory()) {
        return { ok: false, status: 400, payload: { error: "project_path_not_directory" } };
      }

      if (fs.existsSync(path.join(normalizedTarget, ".git"))) {
        return { ok: true, targetPath: normalizedTarget, alreadyExists: true };
      }

      const entries = listDirectoryEntries(normalizedTarget);
      if (entries.length > 0) {
        return { ok: false, status: 409, payload: { error: "target_path_not_empty", target_path: normalizedTarget } };
      }
    } catch {
      // path does not exist yet, allowed
    }

    return { ok: true, targetPath: normalizedTarget, alreadyExists: false };
  }

  app.get("/api/github/status", async (_req, res) => {
    const row = db
      .prepare(
        "SELECT id, email, scope, status, access_token_enc FROM oauth_accounts WHERE provider = 'github' AND status = 'active' ORDER BY priority ASC, updated_at DESC LIMIT 1",
      )
      .get() as
      | { id: string; email: string | null; scope: string | null; status: string; access_token_enc: string | null }
      | undefined;
    if (!row) return res.json({ connected: false, has_repo_scope: false });

    let repoScope = hasRepoScope(row.scope);
    if (!repoScope && row.access_token_enc) {
      try {
        const token = decryptSecret(row.access_token_enc);
        const authHeaders = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };

        const probe = await fetch("https://api.github.com/user", {
          headers: authHeaders,
          signal: AbortSignal.timeout(8000),
        });
        const actualScopes = probe.headers.get("x-oauth-scopes");

        if (probe.ok && typeof actualScopes === "string" && actualScopes.length > 0) {
          db.prepare("UPDATE oauth_accounts SET scope = ?, updated_at = ? WHERE id = ?").run(
            actualScopes,
            Date.now(),
            row.id,
          );
          repoScope = hasRepoScope(actualScopes);
        } else if (probe.ok && (actualScopes === "" || actualScopes === null)) {
          try {
            const repoProbe = await fetch("https://api.github.com/user/repos?per_page=1&visibility=private", {
              headers: authHeaders,
              signal: AbortSignal.timeout(8000),
            });
            if (repoProbe.ok) {
              repoScope = true;
              db.prepare("UPDATE oauth_accounts SET scope = ?, updated_at = ? WHERE id = ?").run(
                "repo (github-app)",
                Date.now(),
                row.id,
              );
            }
          } catch {
            // private repo 접근 체크 실패는 무시하고 기존 결과 유지
          }
        }
      } catch (probeErr) {
        console.error("[GitHub Status] probe error:", probeErr);
      }
    }

    res.json({
      connected: true,
      has_repo_scope: repoScope,
      email: row.email,
      account_id: row.id,
      scope: row.scope,
    });
  });

  app.get("/api/github/repos", async (req, res) => {
    const token = getGitHubAccessToken();
    if (!token) return res.status(401).json({ error: "github_not_connected" });
    const q = String(req.query.q || "").trim();
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const perPage = Math.min(50, Math.max(1, parseInt(String(req.query.per_page || "30"), 10)));
    try {
      let url: string;
      if (q) {
        url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+user:@me&per_page=${perPage}&page=${page}&sort=updated`;
      } else {
        url = `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`;
      }
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return res.status(resp.status).json({ error: "github_api_error", status: resp.status, detail: body });
      }
      const json = await resp.json();
      const repos = q ? ((json as any).items ?? []) : json;
      res.json({
        repos: (repos as any[]).map((r: any) => ({
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          owner: r.owner?.login,
          private: r.private,
          description: r.description,
          default_branch: r.default_branch,
          updated_at: r.updated_at,
          html_url: r.html_url,
          clone_url: r.clone_url,
        })),
      });
    } catch (err) {
      res.status(502).json({ error: "github_fetch_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/github/repos/:owner/:repo/branches", async (req, res) => {
    const pat = typeof req.headers["x-github-pat"] === "string" ? req.headers["x-github-pat"].trim() : null;
    const token = pat || getGitHubAccessToken();
    if (!token) return res.status(401).json({ error: "github_not_connected" });
    const { owner, repo } = req.params;
    const authHeader = pat ? `token ${token}` : `Bearer ${token}`;
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
        {
          headers: {
            Authorization: authHeader,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!resp.ok) {
        if (resp.status === 404) {
          return res.status(404).json({
            error: "repo_not_found",
            message: `Repository ${owner}/${repo} not found or not accessible with current token`,
          });
        }
        if (resp.status === 401) {
          return res.status(401).json({ error: "token_invalid", message: "Token is invalid or expired" });
        }
        return res.status(resp.status).json({ error: "github_api_error", status: resp.status });
      }
      const branches = (await resp.json()) as any[];
      const repoResp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          headers: {
            Authorization: authHeader,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      const repoData = repoResp.ok ? ((await repoResp.json()) as any) : null;
      res.json({
        remote_branches: branches.map((b: any) => ({
          name: b.name,
          sha: b.commit?.sha,
          is_default: b.name === repoData?.default_branch,
        })),
        default_branch: repoData?.default_branch ?? null,
      });
    } catch (err) {
      res.status(502).json({
        error: "github_fetch_failed",
        message: summarizeGitFailure(err instanceof Error ? err.message : String(err), token, "GitHub fetch failed"),
      });
    }
  });

  app.post("/api/github/clone", (req, res) => {
    const pat = typeof req.headers["x-github-pat"] === "string" ? req.headers["x-github-pat"].trim() : null;
    const token = pat || getGitHubAccessToken();
    if (!token) return res.status(401).json({ error: "github_not_connected" });
    const { owner, repo, branch, target_path } = req.body ?? {};
    if (!owner || !repo) return res.status(400).json({ error: "owner_and_repo_required" });

    const repoFullName = `${owner}/${repo}`;
    const targetCheck = validateCloneTargetPath(target_path, repo);
    if (!targetCheck.ok) {
      return res.status(targetCheck.status).json(targetCheck.payload);
    }

    const targetPath = targetCheck.targetPath;
    if (targetCheck.alreadyExists) {
      return res.json({ clone_id: null, already_exists: true, target_path: targetPath });
    }

    const cloneId = randomUUID();
    activeClones.set(cloneId, { status: "cloning", progress: 0, targetPath, repoFullName });

    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    const args = ["clone", "--progress"];
    if (branch) {
      args.push("--branch", branch, "--single-branch");
    }
    args.push(cloneUrl, targetPath);

    const askpass = writeAskpassHelper(token);
    const child = spawn("git", args, {
      env: askpass.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderrBuf = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/Receiving objects:\s+(\d+)%/);
      const resolveMatch = stderrBuf.match(/Resolving deltas:\s+(\d+)%/);
      let pct = 0;
      if (resolveMatch) pct = 50 + Math.floor(parseInt(resolveMatch[1], 10) / 2);
      else if (match) pct = Math.floor(parseInt(match[1], 10) / 2);
      const entry = activeClones.get(cloneId);
      if (entry) {
        entry.progress = pct;
      }
      broadcast("clone_progress", { clone_id: cloneId, progress: pct, status: "cloning" });
    });

    child.on("close", (code) => {
      askpass.cleanup();
      const entry = activeClones.get(cloneId);
      if (entry) {
        if (code === 0) {
          entry.status = "done";
          entry.progress = 100;
          broadcast("clone_progress", { clone_id: cloneId, progress: 100, status: "done" });
        } else {
          entry.status = "error";
          entry.error = summarizeGitFailure(
            stderrBuf,
            token,
            `git clone failed (exit ${typeof code === "number" ? code : "unknown"})`,
          );
          broadcast("clone_progress", {
            clone_id: cloneId,
            progress: entry.progress,
            status: "error",
            error: entry.error,
          });
        }
      }
    });

    child.on("error", (err) => {
      askpass.cleanup();
      const entry = activeClones.get(cloneId);
      if (entry) {
        entry.status = "error";
        entry.error = summarizeGitFailure(err.message, token, "git clone failed");
        broadcast("clone_progress", { clone_id: cloneId, progress: 0, status: "error", error: entry.error });
      }
    });

    res.json({ clone_id: cloneId, target_path: targetPath });
  });

  app.get("/api/github/clone/:cloneId", (req, res) => {
    const entry = activeClones.get(req.params.cloneId);
    if (!entry) return res.status(404).json({ error: "clone_not_found" });
    res.json({ clone_id: req.params.cloneId, ...entry });
  });

  app.get("/api/projects/:id/branches", (req, res) => {
    const project = db.prepare("SELECT id, project_path FROM projects WHERE id = ?").get(req.params.id) as
      | { id: string; project_path: string }
      | undefined;
    if (!project) return res.status(404).json({ error: "project_not_found" });
    try {
      const raw = execFileSync("git", ["branch", "-a", "--no-color"], {
        cwd: project.project_path,
        stdio: "pipe",
        timeout: 10000,
      }).toString();
      const lines = raw
        .split("\n")
        .map((l: string) => l.trim())
        .filter(Boolean);
      const current = lines.find((l: string) => l.startsWith("* "))?.replace("* ", "") ?? null;
      const branches = lines.map((l: string) => l.replace(/^\*\s+/, ""));
      res.json({ branches, current_branch: current });
    } catch (err) {
      res.status(500).json({ error: "git_branch_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });
}
