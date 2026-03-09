import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOneShotRunner } from "./one-shot-runner.ts";
import type { AgentRow } from "./conversation-types.ts";

const tempDirs: string[] = [];

function createAgent(provider = "api"): AgentRow {
  return {
    id: "agent-1",
    name: "Tester",
    name_ko: "테스터",
    role: "engineer",
    personality: null,
    status: "idle",
    department_id: "engineering",
    current_task_id: null,
    avatar_emoji: "T",
    cli_provider: provider,
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    cli_model: null,
    cli_reasoning_level: null,
  };
}

function createLogsDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runAgentOneShot cwd policy", () => {
  it("projectPath가 없고 neutral cwd도 허용되지 않으면 실행하지 않고 missing_project_path를 반환한다", async () => {
    const executeApiProviderAgent = vi.fn();
    const tools = createOneShotRunner({
      logsDir: createLogsDir("climpire-one-shot-missing-"),
      broadcast: vi.fn(),
      getProviderModelConfig: () => ({}),
      executeApiProviderAgent,
      executeCopilotAgent: vi.fn(),
      executeAntigravityAgent: vi.fn(),
      killPidTree: vi.fn(),
      prettyStreamJson: (raw: string) => raw,
      getPreferredLanguage: () => "en",
      normalizeStreamChunk: (raw: Buffer | string) => String(raw),
      hasStructuredJsonLines: () => false,
      normalizeConversationReply: (raw: string) => raw.trim(),
      buildAgentArgs: () => [],
      withCliPathFallback: (pathValue: string | undefined) => String(pathValue ?? ""),
    });

    const result = await tools.runAgentOneShot(createAgent(), "hello", {
      rawOutput: true,
      noTools: true,
    });

    expect(result).toEqual({ text: "", error: "missing_project_path" });
    expect(executeApiProviderAgent).not.toHaveBeenCalled();
  });

  it("noTools + allowNeutralCwd는 호출별 neutral cwd를 만들고 실행 후 정리한다", async () => {
    const logsDir = createLogsDir("climpire-one-shot-neutral-");
    const seenProjectPaths: string[] = [];
    const executeApiProviderAgent = vi.fn(
      async (
        _prompt: string,
        projectPath: string,
        _logStream: fs.WriteStream,
        _signal: AbortSignal,
        _streamTaskId: string | undefined,
        _apiProviderId: string | null,
        _apiModel: string | null,
        write: (text: string) => boolean,
      ) => {
        seenProjectPaths.push(projectPath);
        expect(fs.existsSync(projectPath)).toBe(true);
        write(`cwd:${projectPath}`);
      },
    );
    const tools = createOneShotRunner({
      logsDir,
      broadcast: vi.fn(),
      getProviderModelConfig: () => ({}),
      executeApiProviderAgent,
      executeCopilotAgent: vi.fn(),
      executeAntigravityAgent: vi.fn(),
      killPidTree: vi.fn(),
      prettyStreamJson: (raw: string) => raw,
      getPreferredLanguage: () => "en",
      normalizeStreamChunk: (raw: Buffer | string) => String(raw),
      hasStructuredJsonLines: () => false,
      normalizeConversationReply: (raw: string) => raw.trim(),
      buildAgentArgs: () => [],
      withCliPathFallback: (pathValue: string | undefined) => String(pathValue ?? ""),
    });

    const first = await tools.runAgentOneShot(createAgent(), "hello", {
      rawOutput: true,
      noTools: true,
      allowNeutralCwd: true,
    });
    const second = await tools.runAgentOneShot(createAgent(), "hello again", {
      rawOutput: true,
      noTools: true,
      allowNeutralCwd: true,
    });

    expect(executeApiProviderAgent).toHaveBeenCalledTimes(2);
    expect(seenProjectPaths).toHaveLength(2);
    expect(seenProjectPaths[0]).not.toBe(seenProjectPaths[1]);
    for (const projectPath of seenProjectPaths) {
      expect(projectPath).toContain(path.join(logsDir, "one-shot-neutral"));
      expect(fs.existsSync(projectPath)).toBe(false);
    }
    expect(first.text).toBe(`cwd:${seenProjectPaths[0]}`);
    expect(second.text).toBe(`cwd:${seenProjectPaths[1]}`);
  });
});
