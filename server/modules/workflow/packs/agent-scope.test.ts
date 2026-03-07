import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  resolveEffectiveWorkflowPackKey,
  resolvePackScopedAgentIds,
  resolveScopedTeamLeader,
  resolveTaskScopedAgentIds,
} from "./agent-scope.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      default_pack_key TEXT NOT NULL DEFAULT 'development',
      assignment_mode TEXT NOT NULL DEFAULT 'auto'
    );

    CREATE TABLE project_agents (
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      department_id TEXT,
      role TEXT NOT NULL DEFAULT 'team_leader',
      status TEXT NOT NULL DEFAULT 'idle',
      acts_as_planning_leader INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

function insertAgent(
  db: DatabaseSync,
  id: string,
  departmentId: string,
  role = "team_leader",
  createdAt = 1,
  actsAsPlanningLeader = 0,
): void {
  db.prepare(
    "INSERT INTO agents (id, department_id, role, status, acts_as_planning_leader, created_at) VALUES (?, ?, ?, 'idle', ?, ?)",
  ).run(id, departmentId, role, actsAsPlanningLeader, createdAt);
}

function buildFindTeamLeader(db: DatabaseSync) {
  return (departmentId: string | null, candidateAgentIds?: string[] | null) => {
    if (!departmentId) return null;
    const scopedIds = Array.isArray(candidateAgentIds)
      ? [...new Set(candidateAgentIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : null;
    if (Array.isArray(scopedIds) && scopedIds.length <= 0) return null;

    const clauses = ["role = 'team_leader'", "status != 'offline'"];
    const params: SQLInputValue[] = [];
    if (departmentId === "planning") {
      clauses.push("(department_id = ? OR COALESCE(acts_as_planning_leader, 0) = 1)");
      params.push("planning");
    } else {
      clauses.push("department_id = ?");
      params.push(departmentId);
    }
    if (Array.isArray(scopedIds)) {
      clauses.push(`id IN (${scopedIds.map(() => "?").join(",")})`);
      params.push(...scopedIds);
    }

    return (
      db
        .prepare(
          `
          SELECT id, department_id, role, status, acts_as_planning_leader, created_at
          FROM agents
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at ASC
          LIMIT 1
        `,
        )
        .get(...params) ?? null
    );
  };
}

function sorted(values: string[] | null): string[] | null {
  return Array.isArray(values) ? [...values].sort() : null;
}

describe("agent-scope helpers", () => {
  it("development pack scope excludes foreign office-pack seed agents", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          report: {
            departments: [{ id: "planning" }, { id: "dev" }],
            agents: [
              { id: "report-seed-1", department_id: "planning" },
              { id: "report-seed-2", department_id: "dev" },
            ],
          },
        }),
      );

      insertAgent(db, "planning-global", "planning");
      insertAgent(db, "dev-global", "dev");
      insertAgent(db, "report-seed-1", "planning");
      insertAgent(db, "report-seed-2", "dev");

      const scope = resolvePackScopedAgentIds({
        db,
      });

      expect(sorted(scope)).toEqual(sorted(["planning-global", "dev-global"]));
      expect(scope).not.toEqual(expect.arrayContaining(["report-seed-1", "report-seed-2"]));
    } finally {
      db.close();
    }
  });

  it("project default pack wins over active development office", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          novel: {
            departments: [{ id: "planning" }, { id: "design" }],
            agents: [
              { id: "novel-seed-1", department_id: "planning" },
              { id: "novel-seed-2", department_id: "design" },
            ],
          },
        }),
      );
      db.prepare("INSERT INTO projects (id, default_pack_key, assignment_mode) VALUES (?, ?, 'auto')").run(
        "proj-novel",
        "novel",
      );

      insertAgent(db, "planning-global", "planning");
      insertAgent(db, "novel-seed-1", "planning");
      insertAgent(db, "novel-seed-2", "design");

      expect(resolveEffectiveWorkflowPackKey({ db, projectId: "proj-novel" })).toBe("novel");
      expect(sorted(resolvePackScopedAgentIds({ db, projectId: "proj-novel" }))).toEqual(
        sorted(["novel-seed-1", "novel-seed-2"]),
      );
    } finally {
      db.close();
    }
  });

  it("task-scoped ids intersect pack scope with manual project assignment", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          novel: {
            departments: [{ id: "planning" }, { id: "design" }],
            agents: [
              { id: "novel-seed-1", department_id: "planning" },
              { id: "novel-seed-2", department_id: "design" },
            ],
          },
        }),
      );
      db.prepare("INSERT INTO projects (id, default_pack_key, assignment_mode) VALUES (?, ?, 'manual')").run(
        "proj-manual",
        "novel",
      );
      db.prepare("INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)").run("proj-manual", "novel-seed-2");
      db.prepare("INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)").run("proj-manual", "dev-global");

      insertAgent(db, "dev-global", "dev");
      insertAgent(db, "novel-seed-1", "planning");
      insertAgent(db, "novel-seed-2", "design");

      expect(sorted(resolveTaskScopedAgentIds({ db, projectId: "proj-manual" }))).toEqual(sorted(["novel-seed-2"]));
    } finally {
      db.close();
    }
  });

  it("manual project leader fallback stays inside the same pack", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          video_preprod: {
            departments: [{ id: "planning" }, { id: "dev" }],
            agents: [
              { id: "video-seed-planning", department_id: "planning" },
              { id: "video-seed-dev-leader", department_id: "dev" },
              { id: "video-seed-dev-member", department_id: "dev" },
            ],
          },
        }),
      );
      db.prepare("INSERT INTO projects (id, default_pack_key, assignment_mode) VALUES (?, ?, 'manual')").run(
        "proj-video",
        "video_preprod",
      );
      db.prepare("INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)").run(
        "proj-video",
        "video-seed-dev-member",
      );

      insertAgent(db, "dev-global", "dev", "team_leader", 1);
      insertAgent(db, "video-seed-planning", "planning", "team_leader", 1);
      insertAgent(db, "video-seed-dev-leader", "dev", "team_leader", 1);
      insertAgent(db, "video-seed-dev-member", "dev", "senior", 2);

      const leader = resolveScopedTeamLeader({
        db,
        findTeamLeader: buildFindTeamLeader(db),
        departmentId: "dev",
        projectId: "proj-video",
        scope: "task",
        allowPackFallback: true,
      }) as { id?: string } | null;

      expect(leader?.id).toBe("video-seed-dev-leader");
    } finally {
      db.close();
    }
  });
});
