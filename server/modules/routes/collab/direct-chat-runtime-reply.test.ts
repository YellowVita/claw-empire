import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectReplyRuntime } from "./direct-chat-runtime-reply.ts";
import type { AgentRow } from "./direct-chat-types.ts";

const baseAgent: AgentRow = {
  id: "agent-1",
  name: "Tester",
  name_ko: "테스터",
  role: "senior",
  acts_as_planning_leader: 0,
  personality: null,
  status: "idle",
  department_id: "engineering",
  current_task_id: null,
  avatar_emoji: "T",
  cli_provider: null,
  oauth_account_id: null,
  api_provider_id: null,
  api_model: null,
  cli_model: null,
  cli_reasoning_level: null,
};

function createRuntimeHarness() {
  const runAgentOneShot = vi.fn(async () => ({ text: "General reply" }));
  const sendAgentMessage = vi.fn();
  const logsDir = "C:\\temp\\claw-logs";

  const runtime = createDirectReplyRuntime({
    db: {
      prepare() {
        return {
          get: () => undefined,
        };
      },
    } as any,
    logsDir,
    nowMs: () => 1000,
    broadcast: vi.fn(),
    sendAgentMessage,
    detectProjectPath: () => null,
    normalizeTextField: (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null),
    buildDirectReplyPrompt: () => ({ prompt: "Prompt", lang: "en" }),
    chooseSafeReply: (run: { text?: string }) => run.text ?? "",
    runAgentOneShot,
    executeApiProviderAgent: vi.fn(),
    executeCopilotAgent: vi.fn(),
    executeAntigravityAgent: vi.fn(),
  } as any);

  return {
    runtime,
    runAgentOneShot,
    sendAgentMessage,
    logsDir,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createDirectReplyRuntime", () => {
  it("일반 질의는 pathless 상태에서도 중립 cwd + noTools one-shot으로 처리한다", async () => {
    vi.useFakeTimers();
    const harness = createRuntimeHarness();

    harness.runtime.runDirectReplyExecution(baseAgent, "What is your role?", "chat");
    await vi.runAllTimersAsync();

    expect(harness.runAgentOneShot).toHaveBeenCalledTimes(1);
    expect(harness.runAgentOneShot).toHaveBeenCalledWith(
      baseAgent,
      "Prompt",
      expect.objectContaining({
        noTools: true,
        rawOutput: true,
        allowNeutralCwd: true,
      }),
    );
    expect(harness.sendAgentMessage).toHaveBeenCalledWith(baseAgent, "General reply");
  });

  it("실행성 메시지는 pathless 상태에서 모델 호출 없이 경로 안내를 보낸다", async () => {
    vi.useFakeTimers();
    const harness = createRuntimeHarness();

    harness.runtime.runDirectReplyExecution(baseAgent, "Please review this repo and fix the build.", "chat");
    await vi.runAllTimersAsync();

    expect(harness.runAgentOneShot).not.toHaveBeenCalled();
    expect(harness.sendAgentMessage).toHaveBeenCalledWith(
      baseAgent,
      expect.stringContaining("project path"),
    );
  });
});
