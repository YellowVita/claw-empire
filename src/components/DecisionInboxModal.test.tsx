import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DecisionInboxModal from "./DecisionInboxModal";
import type { DecisionInboxItem } from "./chat/decision-inbox";

function renderModal(item: DecisionInboxItem) {
  render(
    <DecisionInboxModal
      open
      loading={false}
      items={[item]}
      agents={[]}
      busyKey={null}
      uiLanguage="ko"
      onClose={() => {}}
      onRefresh={() => {}}
      onReplyOption={vi.fn()}
      onOpenChat={() => {}}
    />,
  );
}

describe("DecisionInboxModal", () => {
  it("renders blocked guidance for project review cards without options", () => {
    renderModal({
      id: "decision-1",
      kind: "project_review_ready",
      decisionStatus: "blocked",
      agentId: null,
      agentName: "Planning Lead",
      agentNameKo: "기획팀장",
      requestContent: "기획팀장 의견 취합 완료",
      options: [],
      createdAt: 1000,
      projectId: "proj-1",
      projectName: "law_site",
    });

    expect(
      screen.getByText("기획팀장 의견 취합은 완료됐지만, 미완료 검토보완 작업 때문에 회의 시작이 보류되어 있습니다."),
    ).toBeInTheDocument();
    expect(screen.queryByText("기획팀장 의견 취합중...")).not.toBeInTheDocument();
  });

  it("keeps the collecting copy for project review cards that are still consolidating", () => {
    renderModal({
      id: "decision-2",
      kind: "project_review_ready",
      decisionStatus: "collecting",
      agentId: null,
      agentName: "Planning Lead",
      agentNameKo: "기획팀장",
      requestContent: "Collecting",
      options: [],
      createdAt: 1000,
      projectId: "proj-1",
      projectName: "law_site",
    });

    expect(screen.getByText("기획팀장 의견 취합중...")).toBeInTheDocument();
  });
});
