import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMocks.spawn,
  execFileSync: childProcessMocks.execFileSync,
}));

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

class FakeChildProcess extends EventEmitter {
  stderr = new EventEmitter();
  stdout = new EventEmitter();
}

const ORIGINAL_ENV = { ...process.env };

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE oauth_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT,
      email TEXT,
      scope TEXT,
      status TEXT,
      priority INTEGER,
      updated_at INTEGER,
      access_token_enc TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      project_path TEXT
    );
  `);
  return db;
}

async function createHarness() {
  const db = setupDb();
  const postRoutes = new Map<string, RouteHandler>();
  const getRoutes = new Map<string, RouteHandler>();
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const app = {
    post(routePath: string, handler: RouteHandler) {
      postRoutes.set(routePath, handler);
      return this;
    },
    get(routePath: string, handler: RouteHandler) {
      getRoutes.set(routePath, handler);
      return this;
    },
  };

  const { registerGitHubRoutes } = await import("./github-routes.ts");
  registerGitHubRoutes({
    app: app as any,
    db: db as any,
    broadcast(event: string, payload: unknown) {
      broadcasts.push({ event, payload });
    },
    normalizeTextField(value: unknown) {
      return typeof value === "string" && value.trim() ? value.trim() : null;
    },
  });

  return {
    db,
    broadcasts,
    postHandler: postRoutes.get("/api/github/clone"),
    cloneStatusHandler: getRoutes.get("/api/github/clone/:cloneId"),
  };
}

describe("github clone route hardening", () => {
  beforeEach(() => {
    vi.resetModules();
    childProcessMocks.spawn.mockReset();
    childProcessMocks.execFileSync.mockReset();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("uses plain clone URL plus askpass env instead of embedding token in argv", async () => {
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claw-gh-clone-root-"));
    process.env.PROJECT_PATH_ALLOWED_ROOTS = allowedRoot;
    const fakeChild = new FakeChildProcess();
    childProcessMocks.spawn.mockReturnValue(fakeChild as any);

    const { db, postHandler } = await createHarness();
    try {
      const res = createFakeResponse();
      postHandler?.(
        {
          headers: { "x-github-pat": "ghp_secret_token_1234" },
          body: {
            owner: "octocat",
            repo: "hello-world",
            branch: "main",
            target_path: path.join(allowedRoot, "hello-world"),
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
      const [command, args, options] = childProcessMocks.spawn.mock.calls[0] as [string, string[], Record<string, any>];
      expect(command).toBe("git");
      expect(args).toContain("https://github.com/octocat/hello-world.git");
      expect(args.join(" ")).not.toContain("ghp_secret_token_1234");
      expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(options.env.GIT_ASKPASS).toBeTruthy();
      expect(options.env.CLAW_GIT_ASKPASS_TOKEN).toBe("ghp_secret_token_1234");
    } finally {
      db.close();
      fs.rmSync(allowedRoot, { recursive: true, force: true });
    }
  });

  it("rejects relative target_path before spawning git", async () => {
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claw-gh-clone-root-"));
    process.env.PROJECT_PATH_ALLOWED_ROOTS = allowedRoot;
    const { db, postHandler } = await createHarness();
    try {
      const res = createFakeResponse();
      postHandler?.(
        {
          headers: { "x-github-pat": "ghp_secret_token_1234" },
          body: {
            owner: "octocat",
            repo: "hello-world",
            target_path: "relative/path",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: "relative_project_path_not_allowed" });
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    } finally {
      db.close();
      fs.rmSync(allowedRoot, { recursive: true, force: true });
    }
  });

  it("sanitizes clone error payloads and persisted status text", async () => {
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claw-gh-clone-root-"));
    process.env.PROJECT_PATH_ALLOWED_ROOTS = allowedRoot;
    const fakeChild = new FakeChildProcess();
    childProcessMocks.spawn.mockReturnValue(fakeChild as any);

    const { db, broadcasts, postHandler, cloneStatusHandler } = await createHarness();
    try {
      const postRes = createFakeResponse();
      postHandler?.(
        {
          headers: { "x-github-pat": "ghp_secret_token_1234" },
          body: {
            owner: "octocat",
            repo: "hello-world",
            target_path: path.join(allowedRoot, "hello-world"),
          },
        },
        postRes,
      );

      const cloneId = (postRes.payload as { clone_id: string }).clone_id;
      fakeChild.stderr.emit(
        "data",
        Buffer.from("remote: Invalid username or password https://x-access-token:ghp_secret_token_1234@github.com"),
      );
      fakeChild.emit("close", 128);

      const statusRes = createFakeResponse();
      cloneStatusHandler?.({ params: { cloneId } }, statusRes);

      expect(statusRes.statusCode).toBe(200);
      const payload = statusRes.payload as { status: string; error?: string };
      expect(payload.status).toBe("error");
      expect(payload.error).toBeTruthy();
      expect(payload.error).not.toContain("ghp_secret_token_1234");
      expect(payload.error).not.toContain("x-access-token");

      const errorBroadcast = broadcasts.find((entry) => entry.event === "clone_progress" && (entry.payload as any).status === "error");
      expect(errorBroadcast).toBeTruthy();
      expect(JSON.stringify(errorBroadcast?.payload)).not.toContain("ghp_secret_token_1234");
    } finally {
      db.close();
      fs.rmSync(allowedRoot, { recursive: true, force: true });
    }
  });

  it("rejects existing non-empty directories that are not git repositories", async () => {
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claw-gh-clone-root-"));
    const existingDir = path.join(allowedRoot, "hello-world");
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, "README.md"), "occupied");
    process.env.PROJECT_PATH_ALLOWED_ROOTS = allowedRoot;

    const { db, postHandler } = await createHarness();
    try {
      const res = createFakeResponse();
      postHandler?.(
        {
          headers: { "x-github-pat": "ghp_secret_token_1234" },
          body: {
            owner: "octocat",
            repo: "hello-world",
            target_path: existingDir,
          },
        },
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.payload).toEqual({ error: "target_path_not_empty", target_path: existingDir });
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    } finally {
      db.close();
      fs.rmSync(allowedRoot, { recursive: true, force: true });
    }
  });
});
