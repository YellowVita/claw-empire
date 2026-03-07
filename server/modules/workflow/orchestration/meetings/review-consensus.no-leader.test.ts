import { describe, expect, it, vi } from "vitest";

import { createReviewConsensusTools } from "./review-consensus.ts";

describe("review consensus meeting", () => {
  it("범위 안에 팀장이 없으면 자동 승인하지 않고 review hold로 남긴다", () => {
    const reviewInFlight = new Set<string>();
    const reviewRoundState = new Map<string, number>();
    const appendTaskLog = vi.fn();
    const notifyCeo = vi.fn();
    const onApproved = vi.fn();

    const tools = createReviewConsensusTools({
      reviewInFlight,
      reviewRoundState,
      getTaskReviewLeaders: vi.fn(() => []),
      resolveLang: vi.fn(() => "ko"),
      appendTaskLog,
      notifyCeo,
      pickL: (pool: any) => {
        if (Array.isArray(pool?.ko)) return pool.ko[0];
        if (Array.isArray(pool?.en)) return pool.en[0];
        if (Array.isArray(pool)) return pool[0];
        return "";
      },
      l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => ({ ko, en, ja: ja ?? en, zh: zh ?? en }),
    } as any);

    tools.startReviewConsensusMeeting("task-1", "검토 대상", "planning", onApproved);

    expect(onApproved).not.toHaveBeenCalled();
    expect(reviewInFlight.has("task-1")).toBe(false);
    expect(appendTaskLog).toHaveBeenCalledWith(
      "task-1",
      "system",
      expect.stringContaining("Review hold: no scoped team leader"),
    );
    expect(notifyCeo).toHaveBeenCalledWith(expect.stringContaining("Review 단계에서 대기"), "task-1");
  });
});
