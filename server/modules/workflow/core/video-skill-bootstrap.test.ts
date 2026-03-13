import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMocks.execFileSync,
}));

import { ensureVideoPreprodRemotionBestPracticesSkill } from "./video-skill-bootstrap";

describe("ensureVideoPreprodRemotionBestPracticesSkill", () => {
  beforeEach(() => {
    childProcessMocks.execFileSync.mockReset();
    childProcessMocks.execFileSync.mockReturnValue(Buffer.from(""));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("installs the remotion skill for kimi video-preprod agents", () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => null),
        run: vi.fn(() => undefined),
      })),
    };

    const result = ensureVideoPreprodRemotionBestPracticesSkill({
      db: db as any,
      nowMs: () => 1_000,
      workflowPackKey: "video_preprod",
      provider: "kimi",
    });

    expect(result).toEqual({
      state: "installed",
      command: expect.stringContaining("--agent kimi-code"),
    });
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/npx(?:\.cmd)?$/),
      expect.arrayContaining(["--agent", "kimi-code"]),
      expect.any(Object),
    );
  });
});
