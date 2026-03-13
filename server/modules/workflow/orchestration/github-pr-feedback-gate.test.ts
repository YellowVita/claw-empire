import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { encryptSecret } from "../../../oauth/helpers.ts";
import {
  inspectTaskGithubPrFeedbackGate,
  summarizeTaskGithubPrGateSnapshot,
} from "./github-pr-feedback-gate.ts";

function createDb(withToken = true): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE oauth_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      access_token_enc TEXT
    );
  `);
  if (withToken) {
    db.prepare(
      "INSERT INTO oauth_accounts (id, provider, status, priority, updated_at, access_token_enc) VALUES (?, 'github', 'active', 0, 1, ?)",
    ).run("oauth-1", encryptSecret("ghp_test_token"));
  }
  return db;
}

describe("github PR feedback gate", () => {
  it("open PR가 없으면 skipped snapshot을 반환한다", async () => {
    const db = createDb();
    try {
      const snapshot = await inspectTaskGithubPrFeedbackGate({
        db: db as any,
        githubRepo: "acme/repo",
        nowMs: () => 1000,
        fetchImpl: async () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      });

      expect(snapshot).toEqual(
        expect.objectContaining({
          applicable: false,
          status: "skipped",
          pr_url: null,
        }),
      );
      expect(summarizeTaskGithubPrGateSnapshot(snapshot)).toContain("skipped");
    } finally {
      db.close();
    }
  });

  it("selector 기반으로 task branch -> dev PR을 조회한다", async () => {
    const db = createDb();
    const seenUrls: string[] = [];
    try {
      const snapshot = await inspectTaskGithubPrFeedbackGate({
        db: db as any,
        githubRepo: "acme/repo",
        headBranch: "climpire/task1234",
        baseBranch: "dev",
        nowMs: () => 1000,
        fetchImpl: async (input: unknown) => {
          const url = String(input);
          seenUrls.push(url);
          if (url.includes("/pulls?head=")) {
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          throw new Error(`Unexpected URL: ${url}`);
        },
      });

      expect(snapshot.status).toBe("skipped");
      expect(seenUrls[0]).toContain("head=acme:climpire%2Ftask1234");
      expect(seenUrls[0]).toContain("base=dev");
    } finally {
      db.close();
    }
  });

  it("unresolved thread와 failing/pending checks가 있으면 blocked snapshot을 반환한다", async () => {
    const db = createDb();
    const fetchImpl = async (input: unknown) => {
      const url = String(input);
      if (url.includes("/pulls?head=")) {
        return new Response(
          JSON.stringify([
            {
              number: 12,
              html_url: "https://github.com/acme/repo/pull/12",
              head: { sha: "abc123" },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  url: "https://github.com/acme/repo/pull/12",
                  reviewDecision: "CHANGES_REQUESTED",
                  reviewThreads: {
                    nodes: [{ isResolved: false, isOutdated: false }, { isResolved: true, isOutdated: false }],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: [
              { name: "required / unit", status: "completed", conclusion: "failure" },
              { name: "required / e2e", status: "in_progress", conclusion: null },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/status")) {
        return new Response(
          JSON.stringify({
            statuses: [{ state: "success" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      const snapshot = await inspectTaskGithubPrFeedbackGate({
        db: db as any,
        githubRepo: "acme/repo",
        nowMs: () => 2000,
        fetchImpl: fetchImpl as typeof fetch,
      });

      expect(snapshot).toEqual(
        expect.objectContaining({
          applicable: true,
          status: "blocked",
          pr_url: "https://github.com/acme/repo/pull/12",
          unresolved_thread_count: 1,
          change_requests_count: 1,
          failing_check_count: 1,
          pending_check_count: 1,
        }),
      );
      expect(snapshot.blocking_reasons).toEqual(
        expect.arrayContaining([
          "Unresolved review threads: 1",
          "Review decision is CHANGES_REQUESTED",
          "Failing checks: 1",
          "Pending checks: 1",
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("GraphQL pagination을 끝까지 순회해 unresolved thread를 합산한다", async () => {
    const db = createDb();
    let graphqlCall = 0;
    const fetchImpl = async (input: unknown) => {
      const url = String(input);
      if (url.includes("/pulls?head=")) {
        return new Response(
          JSON.stringify([{ number: 99, html_url: "https://github.com/acme/repo/pull/99", head: { sha: "head99" } }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/graphql")) {
        graphqlCall += 1;
        const payload =
          graphqlCall === 1
            ? {
                data: {
                  repository: {
                    pullRequest: {
                      url: "https://github.com/acme/repo/pull/99",
                      reviewDecision: "APPROVED",
                      reviewThreads: {
                        nodes: [{ isResolved: false, isOutdated: false }],
                        pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                      },
                    },
                  },
                },
              }
            : {
                data: {
                  repository: {
                    pullRequest: {
                      url: "https://github.com/acme/repo/pull/99",
                      reviewDecision: "APPROVED",
                      reviewThreads: {
                        nodes: [{ isResolved: false, isOutdated: false }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  },
                },
              };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ statuses: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      const snapshot = await inspectTaskGithubPrFeedbackGate({
        db: db as any,
        githubRepo: "acme/repo",
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect(graphqlCall).toBe(2);
      expect(snapshot).toEqual(
        expect.objectContaining({
          status: "blocked",
          unresolved_thread_count: 2,
        }),
      );
    } finally {
      db.close();
    }
  });

  it("pagination이 상한을 넘기면 inspection_incomplete로 fail-closed 한다", async () => {
    const db = createDb();
    try {
      const snapshot = await inspectTaskGithubPrFeedbackGate({
        db: db as any,
        githubRepo: "acme/repo",
        maxThreadPages: 1,
        fetchImpl: (async (input: unknown) => {
          const url = String(input);
          if (url.includes("/pulls?head=")) {
            return new Response(
              JSON.stringify([{ number: 4, html_url: "https://github.com/acme/repo/pull/4", head: { sha: "head4" } }]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.endsWith("/graphql")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      url: "https://github.com/acme/repo/pull/4",
                      reviewDecision: null,
                      reviewThreads: {
                        nodes: [],
                        pageInfo: { hasNextPage: true, endCursor: "cursor-next" },
                      },
                    },
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          throw new Error(`Unexpected URL: ${url}`);
        }) as typeof fetch,
      });

      expect(snapshot.status).toBe("blocked");
      expect(snapshot.blocking_reasons).toContain("GitHub PR inspection is incomplete");
    } finally {
      db.close();
    }
  });

  it("token이 없으면 fail-closed blocked snapshot을 반환한다", async () => {
    const db = createDb(false);
    try {
      const snapshot = await inspectTaskGithubPrFeedbackGate({
        db: db as any,
        githubRepo: "acme/repo",
      });
      expect(snapshot.status).toBe("blocked");
      expect(snapshot.blocking_reasons).toContain("GitHub token is unavailable");
    } finally {
      db.close();
    }
  });

  it("ignored check policy는 check run name과 status context 모두에 적용된다", async () => {
    const db = createDb();
    const fetchImpl = async (input: unknown) => {
      const url = String(input);
      if (url.includes("/pulls?head=")) {
        return new Response(
          JSON.stringify([
            {
              number: 21,
              html_url: "https://github.com/acme/repo/pull/21",
              head: { sha: "def456" },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  url: "https://github.com/acme/repo/pull/21",
                  reviewDecision: "APPROVED",
                  reviewThreads: {
                    nodes: [],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: [
              { name: "optional / preview", status: "completed", conclusion: "failure" },
              { name: "optional / deploy smoke", status: "in_progress", conclusion: null },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/status")) {
        return new Response(
          JSON.stringify({
            statuses: [{ context: "optional / preview status", state: "pending" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      const snapshot = await inspectTaskGithubPrFeedbackGate({
        db: db as any,
        githubRepo: "acme/repo",
        nowMs: () => 3000,
        fetchImpl: fetchImpl as typeof fetch,
        policy: {
          ignoredCheckNames: ["optional / preview"],
          ignoredCheckPrefixes: ["optional /"],
        },
      });

      expect(snapshot).toEqual(
        expect.objectContaining({
          applicable: true,
          status: "passed",
          failing_check_count: 0,
          pending_check_count: 0,
          ignored_check_count: 3,
          ignored_check_names: [
            "optional / preview",
            "optional / deploy smoke",
            "optional / preview status",
          ],
        }),
      );
      expect(summarizeTaskGithubPrGateSnapshot(snapshot)).toContain("ignored optional checks: 3");
    } finally {
      db.close();
    }
  });
});
