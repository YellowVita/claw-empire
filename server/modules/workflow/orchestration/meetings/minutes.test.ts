import { describe, expect, it, vi } from "vitest";

import { createMeetingMinutesTools, type MeetingTranscriptEntry } from "./minutes.ts";

describe("createMeetingMinutesTools", () => {
  it("collects only structured action-like planned items instead of generic acknowledgements", () => {
    const tools = createMeetingMinutesTools({
      db: { prepare: vi.fn() },
      nowMs: () => 1,
      getDeptName: () => "개발팀",
      getRoleLabel: () => "팀장",
      getAgentDisplayName: () => "Agent",
      pickL: (pool, lang) => pool[lang]?.[0] ?? pool.ko[0],
      l: (ko, en, ja = en, zh = en) => ({ ko, en, ja, zh }),
      summarizeForMeetingBubble: (text: string) => text,
      appendTaskLog: vi.fn(),
      broadcast: vi.fn(),
      REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 8,
      REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 3,
    });

    const transcript: MeetingTranscriptEntry[] = [
      {
        speaker_agent_id: "planning-1",
        speaker: "기획팀장",
        department: "기획팀",
        role: "team_leader",
        content: "좋습니다. 요구사항을 확정하고 일정표를 작성하겠습니다.",
      },
      {
        speaker_agent_id: "dev-1",
        speaker: "개발팀장",
        department: "개발팀",
        role: "team_leader",
        content: "알겠습니다.",
      },
      {
        speaker_agent_id: "qa-1",
        speaker: "QA팀장",
        department: "QA팀",
        role: "team_leader",
        content: "회귀 테스트가 필요합니다. 핵심 시나리오를 정리해 검증하겠습니다.",
      },
    ];

    const items = tools.collectPlannedActionItems(transcript, 10);

    expect(items).toEqual([
      expect.stringContaining("요구사항을 확정하고 일정표를 작성하겠습니다"),
      expect.stringContaining("회귀 테스트가 필요합니다"),
      expect.stringContaining("핵심 시나리오를 정리해 검증하겠습니다"),
    ]);
    expect(items.join("\n")).not.toContain("알겠습니다.");
  });
});
