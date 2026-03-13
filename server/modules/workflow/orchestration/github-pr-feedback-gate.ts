import { buildGitHubApiHeaders, getGitHubAccessToken } from "../../github/auth.ts";
import type { ProjectDevelopmentPrFeedbackGatePolicy } from "../packs/project-config.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
  };
};

type FetchLike = typeof fetch;

export type TaskGithubPrGateStatus = "passed" | "blocked" | "skipped";

export type TaskGithubPrGateSnapshot = {
  applicable: boolean;
  status: TaskGithubPrGateStatus;
  pr_url: string | null;
  pr_number: number | null;
  review_decision: string | null;
  unresolved_thread_count: number;
  change_requests_count: number;
  failing_check_count: number;
  pending_check_count: number;
  ignored_check_count: number;
  ignored_check_names: string[];
  blocking_reasons: string[];
  checked_at: number;
};

type InspectTaskGithubPrFeedbackGateInput = {
  db: DbLike;
  githubRepo: string;
  headBranch?: string;
  baseBranch?: string;
  nowMs?: () => number;
  fetchImpl?: FetchLike;
  maxThreadPages?: number;
  maxCheckPages?: number;
  policy?: ProjectDevelopmentPrFeedbackGatePolicy;
};

type OpenPullRequest = {
  number: number;
  html_url?: string | null;
  head?: {
    sha?: string | null;
  } | null;
};

type GraphqlReviewThreadsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        url?: string | null;
        reviewDecision?: string | null;
        reviewThreads?: {
          nodes?: Array<{
            isResolved?: boolean | null;
            isOutdated?: boolean | null;
          } | null> | null;
          pageInfo?: {
            hasNextPage?: boolean | null;
            endCursor?: string | null;
          } | null;
        } | null;
      } | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null }> | null;
};

function buildSnapshot(
  checkedAt: number,
  patch?: Partial<TaskGithubPrGateSnapshot>,
): TaskGithubPrGateSnapshot {
  return {
    applicable: false,
    status: "skipped",
    pr_url: null,
    pr_number: null,
    review_decision: null,
    unresolved_thread_count: 0,
    change_requests_count: 0,
    failing_check_count: 0,
    pending_check_count: 0,
    ignored_check_count: 0,
    ignored_check_names: [],
    blocking_reasons: [],
    checked_at: checkedAt,
    ...patch,
  };
}

function blockedSnapshot(
  checkedAt: number,
  reason: string,
  patch?: Partial<TaskGithubPrGateSnapshot>,
): TaskGithubPrGateSnapshot {
  return buildSnapshot(checkedAt, {
    applicable: true,
    status: "blocked",
    blocking_reasons: [reason],
    ...patch,
  });
}

function parseGithubRepo(githubRepo: string): { owner: string; repo: string } | null {
  const trimmed = String(githubRepo ?? "").trim();
  if (!trimmed) return null;
  const [owner, repo] = trimmed.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function readJsonOrThrow<T>(response: Response, fallback: string): Promise<T> {
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && !Array.isArray(data) && typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : fallback;
    throw new Error(detail);
  }
  return data as T;
}

async function fetchOpenPullRequest(input: {
  fetchImpl: FetchLike;
  token: string;
  owner: string;
  repo: string;
  headBranch: string;
  baseBranch: string;
}): Promise<OpenPullRequest | null> {
  const { fetchImpl, token, owner, repo, headBranch, baseBranch } = input;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(headBranch)}&base=${encodeURIComponent(baseBranch)}&state=open&per_page=1`;
  const response = await fetchImpl(url, {
    headers: buildGitHubApiHeaders(token),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readJsonOrThrow<unknown>(response, "Failed to load open PR list");
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (!first || typeof first !== "object") return null;
  return first as OpenPullRequest;
}

async function fetchReviewThreadSnapshot(input: {
  fetchImpl: FetchLike;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  maxPages: number;
}): Promise<{
  prUrl: string | null;
  reviewDecision: string | null;
  unresolvedThreadCount: number;
}> {
  const { fetchImpl, token, owner, repo, prNumber, maxPages } = input;
  let unresolvedThreadCount = 0;
  let prUrl: string | null = null;
  let reviewDecision: string | null = null;
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    page += 1;
    if (page > maxPages) {
      throw new Error("inspection_incomplete");
    }

    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: buildGitHubApiHeaders(token, { accept: "application/json" }),
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        query: `
          query PullRequestReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                url
                reviewDecision
                reviewThreads(first: 100, after: $after) {
                  nodes {
                    isResolved
                    isOutdated
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        `,
        variables: {
          owner,
          repo,
          number: prNumber,
          after: cursor,
        },
      }),
    });

    const payload = await readJsonOrThrow<GraphqlReviewThreadsResponse>(response, "Failed to inspect PR review threads");
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((entry) => entry.message || "GraphQL error").join("; "));
    }
    const pr = payload.data?.repository?.pullRequest;
    if (!pr) {
      throw new Error("Pull request not found");
    }

    prUrl = typeof pr.url === "string" && pr.url.trim() ? pr.url : prUrl;
    reviewDecision = typeof pr.reviewDecision === "string" && pr.reviewDecision.trim() ? pr.reviewDecision : null;

    for (const thread of pr.reviewThreads?.nodes ?? []) {
      if (!thread || thread.isResolved === true || thread.isOutdated === true) continue;
      unresolvedThreadCount += 1;
    }

    const hasNextPage = pr.reviewThreads?.pageInfo?.hasNextPage === true;
    const endCursor = pr.reviewThreads?.pageInfo?.endCursor;
    if (!hasNextPage) break;
    if (!endCursor) {
      throw new Error("inspection_incomplete");
    }
    cursor = endCursor;
  }

  return {
    prUrl,
    reviewDecision,
    unresolvedThreadCount,
  };
}

function classifyCheckState(
  rawStatus: unknown,
  rawConclusion: unknown,
): { failing: number; pending: number } {
  const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : "";
  const conclusion = typeof rawConclusion === "string" ? rawConclusion.toLowerCase() : "";
  if (status && status !== "completed") {
    return { failing: 0, pending: 1 };
  }
  if (!status && !conclusion) {
    return { failing: 0, pending: 1 };
  }
  if (!conclusion || conclusion === "neutral" || conclusion === "success" || conclusion === "skipped") {
    return { failing: 0, pending: 0 };
  }
  return { failing: 1, pending: 0 };
}

function normalizeCheckLabel(rawLabel: unknown): string | null {
  return typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : null;
}

function isIgnoredCheckLabel(
  label: string | null,
  policy: ProjectDevelopmentPrFeedbackGatePolicy | undefined,
): boolean {
  if (!label) return false;
  if (policy?.ignoredCheckNames.includes(label)) return true;
  return policy?.ignoredCheckPrefixes.some((prefix) => label.startsWith(prefix)) ?? false;
}

async function fetchCheckCounts(input: {
  fetchImpl: FetchLike;
  token: string;
  owner: string;
  repo: string;
  headSha: string;
  maxPages: number;
  policy?: ProjectDevelopmentPrFeedbackGatePolicy;
}): Promise<{ failing: number; pending: number; ignoredCount: number; ignoredNames: string[] }> {
  const { fetchImpl, token, owner, repo, headSha, maxPages, policy } = input;
  let failing = 0;
  let pending = 0;
  let ignoredCount = 0;
  const ignoredNames: string[] = [];
  const ignoredSet = new Set<string>();

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
      {
        headers: buildGitHubApiHeaders(token),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const payload = await readJsonOrThrow<
      { check_runs?: Array<{ name?: string | null; status?: string; conclusion?: string | null }> }
    >(
      response,
      "Failed to inspect check runs",
    );
    const runs = Array.isArray(payload.check_runs) ? payload.check_runs : [];
    for (const run of runs) {
      const label = normalizeCheckLabel(run?.name);
      if (isIgnoredCheckLabel(label, policy)) {
        ignoredCount += 1;
        if (label && !ignoredSet.has(label)) {
          ignoredSet.add(label);
          ignoredNames.push(label);
        }
        continue;
      }
      const verdict = classifyCheckState(run?.status, run?.conclusion);
      failing += verdict.failing;
      pending += verdict.pending;
    }
    if (runs.length < 100) break;
    if (page === maxPages) {
      throw new Error("inspection_incomplete");
    }
  }

  const statusResponse = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/status`, {
    headers: buildGitHubApiHeaders(token),
    signal: AbortSignal.timeout(15_000),
  });
  const statusPayload = await readJsonOrThrow<{ statuses?: Array<{ context?: string | null; state?: string | null }> }>(
    statusResponse,
    "Failed to inspect status contexts",
  );
  for (const entry of statusPayload.statuses ?? []) {
    const label = normalizeCheckLabel(entry?.context);
    if (isIgnoredCheckLabel(label, policy)) {
      ignoredCount += 1;
      if (label && !ignoredSet.has(label)) {
        ignoredSet.add(label);
        ignoredNames.push(label);
      }
      continue;
    }
    const state = typeof entry?.state === "string" ? entry.state.toLowerCase() : "";
    if (state === "success") continue;
    if (state === "pending") pending += 1;
    else if (state) failing += 1;
  }

  return { failing, pending, ignoredCount, ignoredNames };
}

export async function inspectTaskGithubPrFeedbackGate(
  input: InspectTaskGithubPrFeedbackGateInput,
): Promise<TaskGithubPrGateSnapshot> {
  const checkedAt = input.nowMs ? input.nowMs() : Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxThreadPages = Math.max(1, Number(input.maxThreadPages ?? 10));
  const maxCheckPages = Math.max(1, Number(input.maxCheckPages ?? 5));
  const headBranch = input.headBranch?.trim() || "dev";
  const baseBranch = input.baseBranch?.trim() || "main";
  const parsedRepo = parseGithubRepo(input.githubRepo);
  if (!parsedRepo) {
    return blockedSnapshot(checkedAt, "GitHub repository configuration is invalid");
  }

  const token = getGitHubAccessToken(input.db);
  if (!token) {
    return blockedSnapshot(checkedAt, "GitHub token is unavailable");
  }

  const { owner, repo } = parsedRepo;

  try {
    const openPr = await fetchOpenPullRequest({ fetchImpl, token, owner, repo, headBranch, baseBranch });
    if (!openPr) {
      return buildSnapshot(checkedAt, {
        applicable: false,
        status: "skipped",
      });
    }

    const prNumber = Number(openPr.number ?? 0) || null;
    const headSha = typeof openPr.head?.sha === "string" && openPr.head.sha.trim() ? openPr.head.sha.trim() : null;
    if (!prNumber || !headSha) {
      return blockedSnapshot(checkedAt, "Open PR inspection is incomplete", {
        pr_url: openPr.html_url ?? null,
        pr_number: prNumber,
      });
    }

    const reviewThreads = await fetchReviewThreadSnapshot({
      fetchImpl,
      token,
      owner,
      repo,
      prNumber,
      maxPages: maxThreadPages,
    });
    const checks = await fetchCheckCounts({
      fetchImpl,
      token,
      owner,
      repo,
      headSha,
      maxPages: maxCheckPages,
      policy: input.policy,
    });

    const reviewDecision = reviewThreads.reviewDecision;
    const changeRequestsCount = reviewDecision === "CHANGES_REQUESTED" ? 1 : 0;
    const blockingReasons: string[] = [];
    if (reviewThreads.unresolvedThreadCount > 0) {
      blockingReasons.push(`Unresolved review threads: ${reviewThreads.unresolvedThreadCount}`);
    }
    if (changeRequestsCount > 0) {
      blockingReasons.push("Review decision is CHANGES_REQUESTED");
    }
    if (checks.failing > 0) {
      blockingReasons.push(`Failing checks: ${checks.failing}`);
    }
    if (checks.pending > 0) {
      blockingReasons.push(`Pending checks: ${checks.pending}`);
    }

    return buildSnapshot(checkedAt, {
      applicable: true,
      status: blockingReasons.length > 0 ? "blocked" : "passed",
      pr_url: reviewThreads.prUrl ?? openPr.html_url ?? null,
      pr_number: prNumber,
      review_decision: reviewDecision,
      unresolved_thread_count: reviewThreads.unresolvedThreadCount,
      change_requests_count: changeRequestsCount,
      failing_check_count: checks.failing,
      pending_check_count: checks.pending,
      ignored_check_count: checks.ignoredCount,
      ignored_check_names: checks.ignoredNames,
      blocking_reasons: blockingReasons,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blockedSnapshot(
      checkedAt,
      message === "inspection_incomplete" ? "GitHub PR inspection is incomplete" : `GitHub PR inspection failed: ${message}`,
    );
  }
}

export function summarizeTaskGithubPrGateSnapshot(snapshot: TaskGithubPrGateSnapshot): string {
  const ignoredSuffix =
    snapshot.ignored_check_count > 0 ? ` (ignored optional checks: ${snapshot.ignored_check_count})` : "";
  if (snapshot.status === "skipped") {
    return `GitHub PR feedback gate skipped (no matching open PR)${ignoredSuffix}`;
  }
  if (snapshot.status === "passed") {
    return `GitHub PR feedback gate passed${ignoredSuffix}`;
  }
  if (snapshot.blocking_reasons.length > 0) {
    return `GitHub PR feedback gate blocked: ${snapshot.blocking_reasons.join("; ")}${ignoredSuffix}`;
  }
  return `GitHub PR feedback gate blocked${ignoredSuffix}`;
}
