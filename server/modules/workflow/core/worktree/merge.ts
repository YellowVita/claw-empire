import { execFileSync } from "node:child_process";
import { buildGitHubApiHeaders, getGitHubAccessToken } from "../../../github/auth.ts";
import { getTaskShortId, type WorktreeInfo } from "./lifecycle.ts";
import {
  autoCommitWorktreePendingChanges,
  DIFF_SUMMARY_ERROR,
  DIFF_SUMMARY_NONE,
  hasVisibleDiffSummary,
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

export function createWorktreeMergeTools(deps: CreateWorktreeMergeToolsDeps) {
  const { db, taskWorktrees, appendTaskLog, cleanupWorktree, resolveLang, l, pickL } = deps;

  function mergeWorktree(
    projectPath: string,
    taskId: string,
  ): {
    success: boolean;
    message: string;
    conflicts?: string[];
    autoCommitSha?: string;
    postMergeHeadSha?: string;
    targetBranch?: "main" | "dev";
  } {
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

  function mergeToDevAndCreatePR(
    projectPath: string,
    taskId: string,
    githubRepo: string,
  ): {
    success: boolean;
    message: string;
    conflicts?: string[];
    prUrl?: string;
    autoCommitSha?: string;
    postMergeHeadSha?: string;
    targetBranch?: "main" | "dev";
  } {
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
      if (token) {
        const remoteUrl = `https://x-access-token:${token}@github.com/${githubRepo}.git`;
        execFileSync("git", ["remote", "set-url", "origin", remoteUrl], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        });
      }
      execFileSync("git", ["push", "origin", "dev"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 60000,
      });

      if (token) {
        const [owner, repo] = githubRepo.split("/");
        void (async () => {
          try {
            const listRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:dev&base=main&state=open`,
              { headers: buildGitHubApiHeaders(token) },
            );
            const existingPRs = await listRes.json();
            if (Array.isArray(existingPRs) && existingPRs.length > 0) {
              const prUrl = existingPRs[0].html_url;
              console.log(`[Claw-Empire] Existing PR updated: ${prUrl}`);
              appendTaskLog(taskId, "system", `GitHub PR updated: ${prUrl}`);
            } else {
              const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
                method: "POST",
                headers: {
                  ...buildGitHubApiHeaders(token),
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  title: `[Climpire] ${taskTitle}`,
                  body: `## Climpire Task\n\n**Task:** ${taskTitle}\n**Task ID:** ${taskShortId}\n\nAutomatically created by Climpire workflow.`,
                  head: "dev",
                  base: "main",
                }),
              });
              if (createRes.ok) {
                const prData = (await createRes.json()) as { html_url?: string };
                console.log(`[Claw-Empire] Created PR: ${prData.html_url}`);
                appendTaskLog(taskId, "system", `GitHub PR created: ${prData.html_url}`);
              } else {
                const errBody = await createRes.text();
                console.warn(`[Claw-Empire] Failed to create PR: ${createRes.status} ${errBody}`);
                appendTaskLog(taskId, "system", `GitHub PR creation failed: ${createRes.status}`);
              }
            }
          } catch (prErr) {
            console.warn(`[Claw-Empire] PR creation error:`, prErr);
          }
        })();
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
        autoCommitSha,
        postMergeHeadSha: postMergeHeadSha ?? undefined,
        targetBranch: "dev",
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
    mergeToDevAndCreatePR,
    rollbackTaskWorktree,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
  };
}
