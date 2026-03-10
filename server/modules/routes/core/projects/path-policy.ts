import os from "node:os";
import path from "node:path";

type NormalizeTextField = (value: unknown) => string | null;

function expandProjectPathAliases(value: string): string {
  let candidate = value;
  if (candidate === "~") {
    candidate = os.homedir();
  } else if (candidate.startsWith("~/")) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  } else if (candidate === "/Projects" || candidate.startsWith("/Projects/")) {
    const suffix = candidate.slice("/Projects".length).replace(/^\/+/, "");
    candidate = suffix ? path.join(os.homedir(), "Projects", suffix) : path.join(os.homedir(), "Projects");
  } else if (candidate === "/projects" || candidate.startsWith("/projects/")) {
    const suffix = candidate.slice("/projects".length).replace(/^\/+/, "");
    candidate = suffix ? path.join(os.homedir(), "projects", suffix) : path.join(os.homedir(), "projects");
  }
  return candidate;
}

export function createProjectPathPolicy({ normalizeTextField }: { normalizeTextField: NormalizeTextField }) {
  const PROJECT_PATH_SCOPE_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

  function isRelativeProjectPathInput(raw: unknown): boolean {
    const value = normalizeTextField(raw);
    if (!value) return false;

    const candidate = value;
    if (candidate === "~" || candidate.startsWith("~/")) return false;
    if (candidate === "/Projects" || candidate.startsWith("/Projects/")) return false;
    if (candidate === "/projects" || candidate.startsWith("/projects/")) return false;
    return !path.isAbsolute(candidate);
  }

  function normalizeProjectPathInput(raw: unknown): string | null {
    const value = normalizeTextField(raw);
    if (!value) return null;

    const candidate = expandProjectPathAliases(value);
    if (!path.isAbsolute(candidate)) return null;
    return path.normalize(candidate);
  }

  function normalizePathForScopeCompare(value: string): string {
    const normalized = path.normalize(path.resolve(value));
    return PROJECT_PATH_SCOPE_CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
  }

  function parseProjectPathAllowedRoots(raw: string | undefined): string[] {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return [];
    const parts = text
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      const normalized = normalizeProjectPathInput(part);
      if (!normalized) continue;
      const key = normalizePathForScopeCompare(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  const PROJECT_PATH_ALLOWED_ROOTS = parseProjectPathAllowedRoots(process.env.PROJECT_PATH_ALLOWED_ROOTS);

  function pathInsideRoot(candidatePath: string, rootPath: string): boolean {
    const rel = path.relative(rootPath, candidatePath);
    if (!rel) return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  function isPathInsideAllowedRoots(candidatePath: string): boolean {
    if (PROJECT_PATH_ALLOWED_ROOTS.length === 0) return true;
    const normalizedCandidate = path.normalize(path.resolve(candidatePath));
    return PROJECT_PATH_ALLOWED_ROOTS.some((root) => pathInsideRoot(normalizedCandidate, root));
  }

  function getContainingAllowedRoot(candidatePath: string): string | null {
    if (PROJECT_PATH_ALLOWED_ROOTS.length === 0) return null;
    const normalizedCandidate = path.normalize(path.resolve(candidatePath));
    const containingRoots = PROJECT_PATH_ALLOWED_ROOTS.filter((root) => pathInsideRoot(normalizedCandidate, root));
    if (containingRoots.length === 0) return null;
    containingRoots.sort((a, b) => b.length - a.length);
    return containingRoots[0];
  }

  return {
    PROJECT_PATH_ALLOWED_ROOTS,
    PROJECT_PATH_SCOPE_CASE_INSENSITIVE,
    expandProjectPathAliases,
    isRelativeProjectPathInput,
    normalizeProjectPathInput,
    normalizePathForScopeCompare,
    pathInsideRoot,
    isPathInsideAllowedRoots,
    getContainingAllowedRoot,
  };
}
