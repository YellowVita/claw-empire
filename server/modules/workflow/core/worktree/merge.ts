import { execFileSync } from "node:child_process";
import { buildGitHubApiHeaders, getGitHubAccessToken } from "../../../github/auth.ts";
import { getTaskShortId, type WorktreeInfo } from "./lifecycle.ts";
import {
  autoCommitWorktreePendingChanges,
  DIFF_SUMMARY_ERROR,
  DIFF_SUMMARY_NONE,
  hasVisibleDiffSummary,
  readGitHeadSha,
  readWorktreeStatusShort,
} from "./shared.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
  };
};

type CreateWorktreeMergeToolsDeps = {
  db: DbLike;
  taskWorktrees: Map<string, WorktreeInfo>;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  cleanupWorktree: (projectPath: string, taskId: string) => void;
  resolveLang: (text: string) => string;
  l: (...args: any[]) => any;
  pickL: (...args: any[]) => string;
  fetchImpl?: typeof fetch;
};

export type WorktreeGitHubMergeStrategy = "shared_dev_pr" | "task_branch_pr";
export type WorktreeMergeResult = {
  success: boolean;
  message: string;
  conflicts?: string[];
  prUrl?: string;
  autoCommitSha?: string;
  postMergeHeadSha?: string;
  targetBranch?: "main" | "dev";
  strategy?: WorktreeGitHubMergeStrategy;
};

export type ChildBranchIngestionResult = {
  success: boolean;
  message: string;
  conflicts?: string[];
  autoCommitSha?: string;
  ingestCommitSha?: string;
};

function readHeadSha(projectPath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function readChildBranchNameFromTaskMetadata(db: DbLike, taskId: string): string | null {
  try {
    const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get(taskId) as
      | { workflow_meta_json?: string | null }
      | undefined;
    if (!row?.workflow_meta_json) return null;
    const parsed = JSON.parse(row.workflow_meta_json);
    const branchName = parsed?.collab_branch_artifact?.branch_name;
    return typeof branchName === "string" && branchName.trim() ? branchName.trim() : null;
  } catch {
    return null;
  }
}

function resetSquashMergeState(worktreePath: string): void {
  try {
    execFileSync("git", ["merge", "--abort"], { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
  } catch {
    /* ignore */
  }
  try {
    execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
  } catch {
    /* ignore */
  }
}

export function createWorktreeMergeTools(deps: CreateWorktreeMergeToolsDeps) {
  const { db, taskWorktrees, appendTaskLog, cleanupWorktree, resolveLang, l, pickL, fetchImpl = fetch } = deps;

  function parseGithubRepo(githubRepo: string): { owner: string; repo: string } | null {
    const trimmed = String(githubRepo ?? "").trim();
    if (!trimmed) return null;
    const [owner, repo] = trimmed.split("/");
    if (!owner || !repo) return null;
    return { owner, repo };
  }

  async function upsertPullRequest(input: {
    githubRepo: string;
    token: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ prUrl: string }> {
    const parsedRepo = parseGithubRepo(input.githubRepo);
    if (!parsedRepo) {
      throw new Error(`Invalid github_repo: ${input.githubRepo}`);
    }

    const listRes = await fetchImpl(
      `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}/pulls?head=${parsedRepo.owner}:${encodeURIComponent(input.headBranch)}&base=${encodeURIComponent(input.baseBranch)}&state=open&per_page=1`,
      {
        headers: buildGitHubApiHeaders(input.token),
      },
    );
    const existingPRs = (await listRes.json().catch(() => null)) as Array<{ html_url?: string | null }> | null;
    if (listRes.ok && Array.isArray(existingPRs) && existingPRs.length > 0 && existingPRs[0]?.html_url) {
      return { prUrl: existingPRs[0].html_url };
    }

    const createRes = await fetchImpl(`https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}/pulls`, {
      method: "POST",
      headers: {
        ...buildGitHubApiHeaders(input.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      }),
    });
    const createBody = (await createRes.json().catch(() => null)) as { html_url?: string; message?: string } | null;
    if (!createRes.ok || !createBody?.html_url) {
      throw new Error(createBody?.message || `GitHub PR creation failed: ${createRes.status}`);
    }
    return { prUrl: createBody.html_url };
  }

  function configureGitHubRemote(projectPath: string, githubRepo: string, token: string | null): void {
    if (!token) return;
    let originUrl = "";
    try {
      originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();
    } catch {
      return;
    }

    const normalizedOrigin = originUrl.toLowerCase();
    const normalizedRepo = githubRepo.toLowerCase();
    const isGitHubOrigin =
      normalizedOrigin.includes("github.com/") &&
      (normalizedOrigin.includes(`${normalizedRepo}.git`) || normalizedOrigin.endsWith(normalizedRepo));
    if (!isGitHubOrigin) return;

    const remoteUrl = `https://x-access-token:${token}@github.com/${githubRepo}.git`;
    execFileSync("git", ["remote", "set-url", "origin", remoteUrl], {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 5000,
    });
  }

  function mergeWorktree(projectPath: string, taskId: string): WorktreeMergeResult {
    const info = taskWorktrees.get(taskId);
    if (!info) return { success: false, message: "No worktree found for this task" };
    const taskRow = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(taskId) as
      | {
          title: string;
          description: string | null;
        }
      | undefined;
    const lang = resolveLang(taskRow?.description ?? taskRow?.title ?? "");
    const taskShortId = getTaskShortId(taskId);
    let autoCommitSha: string | undefined;

    try {
      const autoCommit = autoCommitWorktreePendingChanges(taskId, info, appendTaskLog);
      autoCommitSha = autoCommit.commitSha;
      if (autoCommit.error) {
        if (autoCommit.errorKind === "restricted_untracked") {
          return {
            success: false,
            autoCommitSha,
            message: pickL(
              l(
                [
                  `병합 전 제한된 미추적 파일(${autoCommit.restrictedUntrackedCount}개) 때문에 자동 커밋이 차단되었습니다. 제한 파일을 정리한 뒤 다시 시도하세요.`,
                ],
                [
                  `Pre-merge auto-commit was blocked by restricted untracked files (${autoCommit.restrictedUntrackedCount}). Remove/review restricted files and retry.`,
                ],
                [
                  `マージ前の自動コミットは制限付き未追跡ファイル（${autoCommit.restrictedUntrackedCount}件）によりブロックされました。制限ファイルを整理して再試行してください。`,
                ],
                [
                  `合并前自动提交因受限未跟踪文件（${autoCommit.restrictedUntrackedCount}个）被阻止。请处理受限文件后重试。`,
                ],
              ),
              lang,
            ),
          };
        }
        return {
          success: false,
          autoCommitSha,
          message: pickL(
            l(
              [`병합 전 변경사항 자동 커밋에 실패했습니다: ${autoCommit.error}`],
              [`Failed to auto-commit pending changes before merge: ${autoCommit.error}`],
              [`マージ前の未コミット変更の自動コミットに失敗しました: ${autoCommit.error}`],
              [`合并前自动提交未提交更改失败：${autoCommit.error}`],
            ),
            lang,
          ),
        };
      }

      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();

      try {
        const diffCheck = execFileSync("git", ["diff", `${currentBranch}...${info.branchName}`, "--stat"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 10000,
        })
          .toString()
          .trim();
        if (!diffCheck) {
          const postMergeHeadSha = readHeadSha(projectPath);
          return {
            success: true,
            autoCommitSha,
            postMergeHeadSha: postMergeHeadSha ?? undefined,
            targetBranch: currentBranch === "dev" ? "dev" : "main",
            message: pickL(
              l(
                ["변경사항이 없어 병합이 필요하지 않습니다."],
                ["No changes to merge."],
                ["マージする変更がありません。"],
                ["没有可合并的更改。"],
              ),
              lang,
            ),
          };
        }
      } catch {
        /* proceed */
      }

      const mergeMsg = `Merge climpire task ${taskShortId} (branch ${info.branchName})`;
      execFileSync("git", ["merge", info.branchName, "--no-ff", "-m", mergeMsg], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 30000,
      });

      return {
        success: true,
        autoCommitSha,
        postMergeHeadSha: readHeadSha(projectPath) ?? undefined,
        targetBranch: currentBranch === "dev" ? "dev" : "main",
        message: pickL(
          l(
            [`병합 완료: ${info.branchName} → ${currentBranch}`],
            [`Merge completed: ${info.branchName} -> ${currentBranch}`],
            [`マージ完了: ${info.branchName} -> ${currentBranch}`],
            [`合并完成: ${info.branchName} -> ${currentBranch}`],
          ),
          lang,
        ),
      };
    } catch (err: unknown) {
      try {
        const unmerged = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        const conflicts = unmerged ? unmerged.split("\n").filter(Boolean) : [];

        if (conflicts.length > 0) {
          try {
            execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
          } catch {
            /* ignore */
          }

          return {
            success: false,
            autoCommitSha,
            message: pickL(
              l(
                [`병합 충돌 발생: ${conflicts.length}개 파일에서 충돌이 있습니다. 수동 해결이 필요합니다.`],
                [`Merge conflict: ${conflicts.length} file(s) have conflicts and need manual resolution.`],
                [`マージ競合: ${conflicts.length}件のファイルで競合が発生し、手動解決が必要です。`],
                [`合并冲突：${conflicts.length} 个文件存在冲突，需要手动解决。`],
              ),
              lang,
            ),
            conflicts,
          };
        }
      } catch {
        /* ignore */
      }

      try {
        execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        autoCommitSha,
        message: pickL(
          l([`병합 실패: ${msg}`], [`Merge failed: ${msg}`], [`マージ失敗: ${msg}`], [`合并失败: ${msg}`]),
          lang,
        ),
      };
    }
  }

  function ingestChildBranchIntoParent(parentTaskId: string, childTaskId: string): ChildBranchIngestionResult {
    const parentInfo = taskWorktrees.get(parentTaskId);
    if (!parentInfo) return { success: false, message: "No parent worktree found for this task" };
    const childInfo = taskWorktrees.get(childTaskId);
    const childBranchName = childInfo?.branchName ?? readChildBranchNameFromTaskMetadata(db, childTaskId);
    if (!childBranchName) return { success: false, message: "No child branch metadata found for this task" };

    let autoCommitSha: string | undefined;
    try {
      const autoCommit = autoCommitWorktreePendingChanges(parentTaskId, parentInfo, appendTaskLog);
      autoCommitSha = autoCommit.commitSha;
      if (autoCommit.error) {
        if (autoCommit.errorKind === "restricted_untracked") {
          return {
            success: false,
            autoCommitSha,
            message: pickL(
              l(
                [
                  `부모 통합 전 제한된 미추적 파일(${autoCommit.restrictedUntrackedCount}개) 때문에 자동 커밋이 차단되었습니다.`,
                ],
                [
                  `Pre-ingestion auto-commit was blocked by restricted untracked files (${autoCommit.restrictedUntrackedCount}).`,
                ],
                [
                  `親統合前の自動コミットは制限付き未追跡ファイル（${autoCommit.restrictedUntrackedCount}件）によりブロックされました。`,
                ],
                [
                  `父任务吸收前自动提交因受限未跟踪文件（${autoCommit.restrictedUntrackedCount}个）被阻止。`,
                ],
              ),
              resolveLang(""),
            ),
          };
        }
        return {
          success: false,
          autoCommitSha,
          message: `Pre-ingestion auto-commit failed: ${autoCommit.error}`,
        };
      }

      const diffCheck = execFileSync(
        "git",
        ["diff", `${parentInfo.branchName}...${childBranchName}`, "--stat"],
        {
          cwd: parentInfo.worktreePath,
          stdio: "pipe",
          timeout: 10000,
        },
      )
        .toString()
        .trim();
      if (!diffCheck) {
        return {
          success: true,
          autoCommitSha,
          message: `No child changes to ingest from ${childBranchName}.`,
        };
      }

      execFileSync("git", ["merge", "--squash", childBranchName], {
        cwd: parentInfo.worktreePath,
        stdio: "pipe",
        timeout: 30000,
      });

      execFileSync(
        "git",
        [
          "-c",
          "user.name=Claw-Empire",
          "-c",
          "user.email=claw-empire@local",
          "commit",
          "-m",
          `chore: ingest child branch ${getTaskShortId(childTaskId)} (${childInfo.branchName})`,
        ],
        {
          cwd: parentInfo.worktreePath,
          stdio: "pipe",
          timeout: 15000,
        },
      );

      return {
        success: true,
        autoCommitSha,
        ingestCommitSha: readGitHeadSha(parentInfo.worktreePath) ?? undefined,
        message: `Child branch ingested via squash: ${childBranchName} -> ${parentInfo.branchName}`,
      };
    } catch (err: unknown) {
      try {
        const unmerged = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: parentInfo.worktreePath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        const conflicts = unmerged ? unmerged.split("\n").filter(Boolean) : [];

        if (conflicts.length > 0) {
          resetSquashMergeState(parentInfo.worktreePath);

          return {
            success: false,
            autoCommitSha,
            message: `Child branch ingestion conflict: ${conflicts.length} file(s) require manual resolution.`,
            conflicts,
          };
        }
      } catch {
        /* ignore */
      }

      resetSquashMergeState(parentInfo.worktreePath);

      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        autoCommitSha,
        message: `Child branch ingestion failed: ${msg}`,
      };
    }
  }

  async function mergeToDevAndCreatePR(projectPath: string, taskId: string, githubRepo: string): Promise<WorktreeMergeResult> {
    const info = taskWorktrees.get(taskId);
    if (!info) return { success: false, message: "No worktree found for this task" };
    const taskRow = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string } | undefined;
    const taskShortId = getTaskShortId(taskId);
    const taskTitle = taskRow?.title ?? taskShortId;
    let autoCommitSha: string | undefined;

    try {
      const autoCommit = autoCommitWorktreePendingChanges(taskId, info, appendTaskLog);
      autoCommitSha = autoCommit.commitSha;
      if (autoCommit.error) {
        if (autoCommit.errorKind === "restricted_untracked") {
          return {
            success: false,
            autoCommitSha,
            message: `Pre-merge auto-commit blocked by restricted untracked files (${autoCommit.restrictedUntrackedCount}). Remove or handle restricted files and retry.`,
          };
        }
        return { success: false, autoCommitSha, message: `Pre-merge auto-commit failed: ${autoCommit.error}` };
      }

      try {
        const devExists = execFileSync("git", ["branch", "--list", "dev"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        if (!devExists) {
          execFileSync("git", ["branch", "dev", "main"], {
            cwd: projectPath,
            stdio: "pipe",
            timeout: 5000,
          });
          console.log(`[Claw-Empire] Created dev branch from main for task ${taskShortId}`);
        }
      } catch {
        try {
          execFileSync("git", ["branch", "dev", "HEAD"], {
            cwd: projectPath,
            stdio: "pipe",
            timeout: 5000,
          });
        } catch {
          /* ignore */
        }
      }

      execFileSync("git", ["checkout", "dev"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      });

      const mergeMsg = `Merge climpire task ${taskShortId} (branch ${info.branchName})`;
      execFileSync("git", ["merge", info.branchName, "--no-ff", "-m", mergeMsg], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 30000,
      });

      const token = getGitHubAccessToken(db);
      configureGitHubRemote(projectPath, githubRepo, token);
      execFileSync("git", ["push", "origin", "dev"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 60000,
      });

      let prUrl: string | undefined;
      if (token) {
        try {
          const pr = await upsertPullRequest({
            githubRepo,
            token,
            headBranch: "dev",
            baseBranch: "main",
            title: `[Climpire] ${taskTitle}`,
            body: `## Climpire Task\n\n**Task:** ${taskTitle}\n**Task ID:** ${taskShortId}\n\nAutomatically created by Climpire workflow.`,
          });
          prUrl = pr.prUrl;
          appendTaskLog(taskId, "system", `GitHub PR ready: ${prUrl}`);
        } catch (prError) {
          const prMessage = prError instanceof Error ? prError.message : String(prError);
          appendTaskLog(taskId, "system", `GitHub PR sync failed: ${prMessage}`);
        }
      } else {
        appendTaskLog(taskId, "system", "GitHub token unavailable; skipped shared dev PR sync.");
      }

      const postMergeHeadSha = readHeadSha(projectPath);

      try {
        execFileSync("git", ["checkout", "main"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        });
      } catch {
        /* best effort */
      }

      return {
        success: true,
        message: `Merged ${info.branchName} → dev and pushed to origin.`,
        prUrl,
        autoCommitSha,
        postMergeHeadSha: postMergeHeadSha ?? undefined,
        targetBranch: "dev",
        strategy: "shared_dev_pr",
      };
    } catch (err: unknown) {
      try {
        const unmerged = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        const conflicts = unmerged ? unmerged.split("\n").filter(Boolean) : [];
        if (conflicts.length > 0) {
          try {
            execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
          } catch {
            /* ignore */
          }
          try {
            execFileSync("git", ["checkout", "main"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
          } catch {
            /* ignore */
          }
          return {
            success: false,
            autoCommitSha,
            message: `Merge conflict: ${conflicts.length} file(s) have conflicts.`,
            conflicts,
          };
        }
      } catch {
        /* ignore */
      }

      try {
        execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["checkout", "main"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }

      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, autoCommitSha, message: `Dev merge failed: ${msg}` };
    }
  }

  async function pushTaskBranchAndCreatePR(
    projectPath: string,
    taskId: string,
    githubRepo: string,
  ): Promise<WorktreeMergeResult> {
    const info = taskWorktrees.get(taskId);
    if (!info) return { success: false, message: "No worktree found for this task" };
    const taskRow = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string } | undefined;
    const taskShortId = getTaskShortId(taskId);
    const taskTitle = taskRow?.title ?? taskShortId;
    let autoCommitSha: string | undefined;

    try {
      const autoCommit = autoCommitWorktreePendingChanges(taskId, info, appendTaskLog);
      autoCommitSha = autoCommit.commitSha;
      if (autoCommit.error) {
        if (autoCommit.errorKind === "restricted_untracked") {
          return {
            success: false,
            autoCommitSha,
            message: `Pre-PR auto-commit blocked by restricted untracked files (${autoCommit.restrictedUntrackedCount}). Remove or handle restricted files and retry.`,
          };
        }
        return { success: false, autoCommitSha, message: `Pre-PR auto-commit failed: ${autoCommit.error}` };
      }

      const token = getGitHubAccessToken(db);
      if (!token) {
        return {
          success: false,
          autoCommitSha,
          message: "GitHub token is required to create or update a task branch PR.",
          targetBranch: "dev",
          strategy: "task_branch_pr",
        };
      }

      configureGitHubRemote(projectPath, githubRepo, token);
      execFileSync("git", ["push", "origin", info.branchName], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 60000,
      });

      const pr = await upsertPullRequest({
        githubRepo,
        token,
        headBranch: info.branchName,
        baseBranch: "dev",
        title: `[Climpire] ${taskTitle}`,
        body: `## Climpire Task\n\n**Task:** ${taskTitle}\n**Task ID:** ${taskShortId}\n\nAutomatically created by Climpire workflow.`,
      });
      appendTaskLog(taskId, "system", `GitHub task PR ready: ${pr.prUrl}`);

      return {
        success: true,
        message: `Pushed ${info.branchName} and created/updated PR to dev.`,
        prUrl: pr.prUrl,
        autoCommitSha,
        targetBranch: "dev",
        strategy: "task_branch_pr",
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        autoCommitSha,
        message: `Task branch PR sync failed: ${msg}`,
        targetBranch: "dev",
        strategy: "task_branch_pr",
      };
    }
  }

  function getWorktreeDiffSummary(projectPath: string, taskId: string): string {
    const info = taskWorktrees.get(taskId);
    if (!info) return "";

    try {
      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();

      const stat = execFileSync("git", ["diff", `${currentBranch}...${info.branchName}`, "--stat"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 10000,
      })
        .toString()
        .trim();

      const worktreePending = readWorktreeStatusShort(info.worktreePath);
      if (stat && worktreePending) return `${stat}\n\n[uncommitted worktree changes]\n${worktreePending}`;
      if (stat) return stat;
      if (worktreePending) return `[uncommitted worktree changes]\n${worktreePending}`;
      return DIFF_SUMMARY_NONE;
    } catch {
      return DIFF_SUMMARY_ERROR;
    }
  }

  function rollbackTaskWorktree(taskId: string, reason: string): boolean {
    const info = taskWorktrees.get(taskId);
    if (!info) return false;

    const diffSummary = getWorktreeDiffSummary(info.projectPath, taskId);
    if (hasVisibleDiffSummary(diffSummary)) {
      appendTaskLog(taskId, "system", `Rollback(${reason}) diff summary:\n${diffSummary}`);
    }

    cleanupWorktree(info.projectPath, taskId);
    appendTaskLog(taskId, "system", `Worktree rollback completed (${reason})`);
    return true;
  }

  return {
    mergeWorktree,
    ingestChildBranchIntoParent,
    mergeToDevAndCreatePR,
    pushTaskBranchAndCreatePR,
    rollbackTaskWorktree,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
  };
}
