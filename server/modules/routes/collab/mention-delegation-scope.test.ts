import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { resolveMentionDelegationScope } from "./mention-delegation-scope.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      department_id TEXT
    );
  `);
  return db;
}

function insertAgent(db: DatabaseSync, id: string, departmentId: string): void {
  db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run(id, departmentId);
}

function pickTeamLeader(candidateIds: string[] | null, departmentId: string): string | null {
  if (!Array.isArray(candidateIds)) return null;
  return candidateIds.find((id) => {
    const normalized = String(id ?? "").trim();
    return normalized.endsWith("-seed-2") || normalized === `${departmentId}-global`;
  }) ?? null;
}

describe("resolveMentionDelegationScope", () => {
  it("development office mention delegation excludes foreign office-pack leaders", () => {
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

      const scope = resolveMentionDelegationScope(db, "planning-global", "dev");

      expect(scope.workflowPackKey).toBe("development");
      expect(scope.candidateAgentIds).toEqual(expect.arrayContaining(["planning-global", "dev-global"]));
      expect(scope.candidateAgentIds).not.toEqual(expect.arrayContaining(["report-seed-1", "report-seed-2"]));
      expect(pickTeamLeader(scope.candidateAgentIds, "dev")).toBe("dev-global");
    } finally {
      db.close();
    }
  });

  it("seed origin leader keeps mention delegation inside the same office pack", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          video_preprod: {
            departments: [{ id: "planning" }, { id: "dev" }],
            agents: [
              { id: "video_preprod-seed-1", department_id: "planning" },
              { id: "video_preprod-seed-2", department_id: "dev" },
            ],
          },
        }),
      );

      insertAgent(db, "planning-global", "planning");
      insertAgent(db, "dev-global", "dev");
      insertAgent(db, "video_preprod-seed-1", "planning");
      insertAgent(db, "video_preprod-seed-2", "dev");

      const scope = resolveMentionDelegationScope(db, "video_preprod-seed-1", "dev");

      expect(scope.workflowPackKey).toBe("video_preprod");
      expect(scope.candidateAgentIds).toEqual(expect.arrayContaining(["video_preprod-seed-1", "video_preprod-seed-2"]));
      expect(scope.candidateAgentIds).not.toEqual(expect.arrayContaining(["planning-global", "dev-global"]));
      expect(pickTeamLeader(scope.candidateAgentIds, "dev")).toBe("video_preprod-seed-2");
    } finally {
      db.close();
    }
  });
});
