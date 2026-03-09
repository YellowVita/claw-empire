import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveProjectDefaultPackKey,
  resolveTaskPackKeyById,
  resolveTaskWorkflowPackSelection,
  resolveWorkflowPackKeyForTask,
} from "./task-pack-resolver.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeWorkflowConfig(projectPath: string, raw: string | Record<string, unknown>): void {
  const content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  fs.writeFileSync(path.join(projectPath, ".claw-workflow.json"), content, "utf8");
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      default_pack_key TEXT NOT NULL DEFAULT 'development'
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      workflow_pack_key TEXT NOT NULL DEFAULT 'development'
    );
  `);
  return db;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("task-pack-resolver", () => {
  it("explicit pack key가 있으면 최우선으로 사용한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-1", "novel");
      db.prepare("INSERT INTO tasks (id, workflow_pack_key) VALUES (?, ?)").run("task-1", "report");
      const resolved = resolveWorkflowPackKeyForTask({
        db,
        explicitPackKey: "video_preprod",
        sourceTaskId: "task-1",
        projectId: "project-1",
      });
      expect(resolved).toBe("video_preprod");
    } finally {
      db.close();
    }
  });

  it("source task pack -> project default 순으로 폴백한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-1", "novel");
      db.prepare("INSERT INTO tasks (id, workflow_pack_key) VALUES (?, ?)").run("task-1", "report");

      const fromTask = resolveWorkflowPackKeyForTask({
        db,
        sourceTaskId: "task-1",
        projectId: "project-1",
      });
      const fromProject = resolveWorkflowPackKeyForTask({
        db,
        sourceTaskId: "missing-task",
        projectId: "project-1",
      });

      expect(fromTask).toBe("report");
      expect(fromProject).toBe("novel");
    } finally {
      db.close();
    }
  });

  it("유효한 값이 없으면 fallback/default를 사용한다", () => {
    const db = setupDb();
    try {
      const withFallback = resolveWorkflowPackKeyForTask({
        db,
        explicitPackKey: "invalid-pack",
        fallbackPackKey: "report",
      });
      const withDefault = resolveWorkflowPackKeyForTask({
        db,
        explicitPackKey: "invalid-pack",
      });
      expect(withFallback).toBe("report");
      expect(withDefault).toBe("development");
    } finally {
      db.close();
    }
  });

  it("project/task 단건 조회 헬퍼가 유효한 pack만 반환한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-1", "roleplay");
      db.prepare("INSERT INTO tasks (id, workflow_pack_key) VALUES (?, ?)").run("task-1", "report");
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-2", "invalid");

      expect(resolveProjectDefaultPackKey(db, "project-1")).toBe("roleplay");
      expect(resolveProjectDefaultPackKey(db, "project-2")).toBeNull();
      expect(resolveTaskPackKeyById(db, "task-1")).toBe("report");
      expect(resolveTaskPackKeyById(db, "missing")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("file default pack이 project default보다 우선한다", () => {
    const db = setupDb();
    const projectPath = createTempDir("claw-pack-file-default-");
    writeWorkflowConfig(projectPath, { defaultWorkflowPackKey: "report" });
    try {
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-1", "novel");
      const resolved = resolveTaskWorkflowPackSelection({
        db,
        projectId: "project-1",
        projectPath,
      });
      expect(resolved).toEqual({
        packKey: "report",
        source: "file_default",
        warnings: [],
      });
    } finally {
      db.close();
    }
  });

  it("invalid file default는 warning 후 project default로 fallback 한다", () => {
    const db = setupDb();
    const projectPath = createTempDir("claw-pack-file-invalid-");
    writeWorkflowConfig(projectPath, { defaultWorkflowPackKey: "invalid-pack" });
    try {
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-1", "novel");
      const resolved = resolveTaskWorkflowPackSelection({
        db,
        projectId: "project-1",
        projectPath,
      });
      expect(resolved.packKey).toBe("novel");
      expect(resolved.source).toBe("project_default");
      expect(resolved.warnings).toEqual([
        ".claw-workflow.json invalid defaultWorkflowPackKey, falling back to project default",
      ]);
    } finally {
      db.close();
    }
  });
});
