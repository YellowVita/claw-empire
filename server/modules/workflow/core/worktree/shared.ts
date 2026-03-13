import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getTaskShortId } from "./lifecycle.ts";

export const DIFF_SUMMARY_NONE = "__DIFF_NONE__";
export const DIFF_SUMMARY_ERROR = "__DIFF_ERROR__";

const RUNTIME_TASK_ARTIFACT_EXACT_PATHS = new Set([
  "tasks/todo.md",
  "tasks/lessons.md",
  "tasks/review.md",
]);
const RUNTIME_TASK_ARTIFACT_PREFIXES = ["tasks/runtime/", "tasks/subtasks/"];
const RUNTIME_TASK_ARTIFACT_RESET_TARGETS = [
  "tasks/todo.md",
  "tasks/lessons.md",
  "tasks/review.md",
  "tasks/runtime",
  "tasks/subtasks",
];

const AUTO_COMMIT_ALLOWED_UNTRACKED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".xml",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".gql",
  ".vue",
  ".svelte",
]);
const AUTO_COMMIT_ALLOWED_UNTRACKED_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "cmakelists.txt",
  "readme",
  "license",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".prettierrc",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.json",
  ".env.example",
]);
const AUTO_COMMIT_BLOCKED_DIR_SEGMENTS = new Set([
  ".git",
  ".climpire",
  ".climpire-worktrees",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "logs",
  "tmp",
  "temp",
]);
const AUTO_COMMIT_ALLOWED_DOT_DIR_SEGMENTS = new Set([".github", ".storybook", ".changeset", ".husky", ".vscode"]);
const AUTO_COMMIT_BLOCKED_FILE_PATTERN =
  /(^|\/)(\.env($|[./])|id_rsa|id_ed25519|known_hosts|authorized_keys|.*\.(pem|key|p12|pfx|crt|cer|der|kdbx|sqlite|db|log|zip|tar|gz|tgz|rar|7z))$/i;

export function hasVisibleDiffSummary(summary: string): boolean {
  return Boolean(summary && summary !== DIFF_SUMMARY_NONE && summary !== DIFF_SUMMARY_ERROR);
}

function normalizeRepoRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function isRuntimeTaskArtifactPath(filePath: string): boolean {
  const normalized = normalizeRepoRelativePath(filePath).toLowerCase();
  if (!normalized) return false;
  if (RUNTIME_TASK_ARTIFACT_EXACT_PATHS.has(normalized)) return true;
  return RUNTIME_TASK_ARTIFACT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function filterRuntimeTaskArtifactPaths(filePaths: string[]): string[] {
  return filePaths.filter((entry) => !isRuntimeTaskArtifactPath(entry));
}

function buildRuntimeTaskArtifactExcludePathspecs(): string[] {
  return [...RUNTIME_TASK_ARTIFACT_EXACT_PATHS, ...RUNTIME_TASK_ARTIFACT_PREFIXES].map(
    (entry) => `:(exclude)${entry}`,
  );
}

function buildGitScopeArgs(): string[] {
  return ["--", ".", ...buildRuntimeTaskArtifactExcludePathspecs()];
}

function resolveGitDirPath(repoPath: string): string | null {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoPath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    if (!gitDir) return null;
    return path.resolve(repoPath, gitDir);
  } catch {
    return null;
  }
}

export function ensureRuntimeTaskArtifactLocalExcludes(repoPath: string): void {
  const gitDir = resolveGitDirPath(repoPath);
  if (!gitDir) return;
  const infoDir = path.join(gitDir, "info");
  const excludePath = path.join(infoDir, "exclude");
  const lines = [
    "tasks/todo.md",
    "tasks/lessons.md",
    "tasks/review.md",
    "tasks/runtime/",
    "tasks/subtasks/",
  ];
  try {
    fs.mkdirSync(infoDir, { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const appendLines = lines.filter((line) => !existing.includes(line));
    if (appendLines.length <= 0) return;
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${prefix}${appendLines.join("\n")}\n`, "utf8");
  } catch {
    // ignore exclude sync failures
  }
}

export function discardRuntimeTaskArtifactChanges(worktreePath: string): string[] {
  const restored: string[] = [];
  for (const relPath of RUNTIME_TASK_ARTIFACT_RESET_TARGETS) {
    try {
      execFileSync("git", ["restore", "--staged", "--worktree", "--source=HEAD", "--", relPath], {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
      });
      restored.push(relPath);
    } catch {
      // Ignore unmatched runtime paths.
    }
  }
  return restored;
}

export function readWorktreeStatusShort(worktreePath: string): string {
  try {
    ensureRuntimeTaskArtifactLocalExcludes(worktreePath);
    return execFileSync("git", ["status", "--short", ...buildGitScopeArgs()], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

export function readGitHeadSha(worktreePath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function readGitNullSeparated(worktreePath: string, args: string[]): string[] {
  try {
    const out = execFileSync("git", args, {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 10000,
    }).toString("utf8");
    return out.split("\0").filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function isSafeUntrackedPathForAutoCommit(filePath: string): boolean {
  const normalized = normalizeRepoRelativePath(filePath);
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) return false;

  const lower = normalized.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  for (const seg of segments.slice(0, -1)) {
    if (seg.startsWith(".") && !AUTO_COMMIT_ALLOWED_DOT_DIR_SEGMENTS.has(seg)) return false;
    if (AUTO_COMMIT_BLOCKED_DIR_SEGMENTS.has(seg)) return false;
  }

  if (AUTO_COMMIT_BLOCKED_FILE_PATTERN.test(lower)) {
    // Explicit allow for template env file
    if (lower === ".env.example" || lower.endsWith("/.env.example")) return true;
    return false;
  }

  const base = segments[segments.length - 1] || "";
  if (AUTO_COMMIT_ALLOWED_UNTRACKED_BASENAMES.has(base)) return true;
  const ext = path.extname(base);
  return AUTO_COMMIT_ALLOWED_UNTRACKED_EXTENSIONS.has(ext);
}

function stageWorktreeChangesForAutoCommit(
  taskId: string,
  worktreePath: string,
  appendTaskLog: (taskId: string, kind: string, message: string) => void,
): { stagedPaths: string[]; blockedUntrackedPaths: string[]; error: string | null } {
  try {
    ensureRuntimeTaskArtifactLocalExcludes(worktreePath);
    const restoredRuntimePaths = discardRuntimeTaskArtifactChanges(worktreePath);
    if (restoredRuntimePaths.length > 0) {
      appendTaskLog(
        taskId,
        "system",
        `Runtime task artifacts were reset before auto-commit: ${restoredRuntimePaths.join(", ")}`,
      );
    }

    // Tracked edits/deletions/renames are safe to stage in bulk.
    execFileSync("git", ["add", "-u", ...buildGitScopeArgs()], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 10000,
    });

    const untracked = readGitNullSeparated(worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...buildGitScopeArgs(),
    ]);
    const blockedUntrackedPaths: string[] = [];
    const safeUntrackedPaths: string[] = [];
    for (const rawPath of untracked) {
      const relPath = normalizeRepoRelativePath(rawPath);
      if (!relPath) continue;
      if (isRuntimeTaskArtifactPath(relPath)) continue;
      if (!isSafeUntrackedPathForAutoCommit(relPath)) {
        blockedUntrackedPaths.push(relPath);
        continue;
      }
      safeUntrackedPaths.push(relPath);
    }

    if (safeUntrackedPaths.length > 0) {
      const chunkSize = 200;
      for (let i = 0; i < safeUntrackedPaths.length; i += chunkSize) {
        const chunk = safeUntrackedPaths.slice(i, i + chunkSize);
        execFileSync("git", ["add", "--", ...chunk], {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: 10000,
        });
      }
    }

    if (blockedUntrackedPaths.length > 0) {
      const preview = blockedUntrackedPaths.slice(0, 8).join(", ");
      const suffix = blockedUntrackedPaths.length > 8 ? " ..." : "";
      appendTaskLog(
        taskId,
        "system",
        `Auto-commit skipped ${blockedUntrackedPaths.length} restricted untracked path(s): ${preview}${suffix}`,
      );
    }

    const stagedPaths = readGitNullSeparated(worktreePath, ["diff", "--cached", "--name-only", "-z", ...buildGitScopeArgs()])
      .map(normalizeRepoRelativePath)
      .filter(Boolean);
    return { stagedPaths, blockedUntrackedPaths, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stagedPaths: [], blockedUntrackedPaths: [], error: msg };
  }
}

export function autoCommitWorktreePendingChanges(
  taskId: string,
  info: { worktreePath: string; branchName: string },
  appendTaskLog: (taskId: string, kind: string, message: string) => void,
): {
  committed: boolean;
  error: string | null;
  errorKind: "restricted_untracked" | "git_error" | null;
  restrictedUntrackedCount: number;
  commitSha?: string;
} {
  const statusBefore = readWorktreeStatusShort(info.worktreePath);
  if (!statusBefore) {
    return {
      committed: false,
      error: null,
      errorKind: null,
      restrictedUntrackedCount: 0,
    };
  }

  try {
    const staged = stageWorktreeChangesForAutoCommit(taskId, info.worktreePath, appendTaskLog);
    if (staged.error) {
      return {
        committed: false,
        error: staged.error,
        errorKind: "git_error",
        restrictedUntrackedCount: 0,
      };
    }
    if (staged.stagedPaths.length === 0) {
      if (staged.blockedUntrackedPaths.length > 0) {
        return {
          committed: false,
          error: `auto-commit blocked by restricted untracked files (${staged.blockedUntrackedPaths.length})`,
          errorKind: "restricted_untracked",
          restrictedUntrackedCount: staged.blockedUntrackedPaths.length,
        };
      }
      return {
        committed: false,
        error: null,
        errorKind: null,
        restrictedUntrackedCount: 0,
      };
    }

    execFileSync(
      "git",
      [
        "-c",
        "user.name=Claw-Empire",
        "-c",
        "user.email=claw-empire@local",
        "commit",
        "-m",
        `chore: auto-commit pending task changes (${getTaskShortId(taskId)})`,
      ],
      {
        cwd: info.worktreePath,
        stdio: "pipe",
        timeout: 15000,
      },
    );
    appendTaskLog(taskId, "system", `Worktree auto-commit created on ${info.branchName} before merge`);
    const commitSha = readGitHeadSha(info.worktreePath);
    return {
      committed: true,
      error: null,
      errorKind: null,
      restrictedUntrackedCount: 0,
      commitSha: commitSha ?? undefined,
    };
  } catch (err: unknown) {
    const statusAfter = readWorktreeStatusShort(info.worktreePath);
    if (!statusAfter) {
      return {
        committed: false,
        error: null,
        errorKind: null,
        restrictedUntrackedCount: 0,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    appendTaskLog(taskId, "system", `Worktree auto-commit failed: ${msg}`);
    return {
      committed: false,
      error: msg,
      errorKind: "git_error",
      restrictedUntrackedCount: 0,
    };
  }
}

export function captureWorktreeBranchArtifact(
  taskId: string,
  info: { worktreePath: string; branchName: string },
  appendTaskLog: (taskId: string, kind: string, message: string) => void,
): {
  success: boolean;
  branchName: string;
  headSha?: string;
  autoCommitSha?: string;
  message?: string;
} {
  const autoCommit = autoCommitWorktreePendingChanges(taskId, info, appendTaskLog);
  if (autoCommit.error) {
    return {
      success: false,
      branchName: info.branchName,
      autoCommitSha: autoCommit.commitSha,
      message: autoCommit.errorKind === "restricted_untracked"
        ? `restricted_untracked:${autoCommit.restrictedUntrackedCount}`
        : autoCommit.error,
    };
  }

  const headSha = readGitHeadSha(info.worktreePath);
  if (!headSha) {
    return {
      success: false,
      branchName: info.branchName,
      autoCommitSha: autoCommit.commitSha,
      message: "missing_head_sha",
    };
  }

  return {
    success: true,
    branchName: info.branchName,
    headSha,
    autoCommitSha: autoCommit.commitSha,
  };
}
