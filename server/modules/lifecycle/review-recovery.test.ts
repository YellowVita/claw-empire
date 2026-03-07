import { describe, expect, it } from "vitest";

import { filterStartupReviewRecoveryRows, shouldReplayReviewOnStartup } from "./review-recovery.ts";

describe("startup review recovery", () => {
  it("루트 review task는 startup 시 복구 대상으로 유지한다", () => {
    expect(shouldReplayReviewOnStartup({ source_task_id: null, parent_status: null })).toBe(true);
  });

  it("부모가 아직 진행 중인 child review task는 startup 자동 완료 대상에서 제외한다", () => {
    expect(shouldReplayReviewOnStartup({ source_task_id: "parent-1", parent_status: "review" })).toBe(false);
    expect(shouldReplayReviewOnStartup({ source_task_id: "parent-1", parent_status: "in_progress" })).toBe(false);
  });

  it("부모가 종료되었거나 없으면 child review task를 cleanup 대상으로 포함한다", () => {
    expect(shouldReplayReviewOnStartup({ source_task_id: "parent-1", parent_status: "done" })).toBe(true);
    expect(shouldReplayReviewOnStartup({ source_task_id: "parent-1", parent_status: "cancelled" })).toBe(true);
    expect(shouldReplayReviewOnStartup({ source_task_id: "parent-1", parent_status: null })).toBe(true);
  });

  it("startup 복구 목록에서 활성 parent를 가진 child review task를 걸러낸다", () => {
    const rows = [
      { id: "root", title: "root", source_task_id: null, parent_status: null },
      { id: "child-active", title: "child-active", source_task_id: "parent-1", parent_status: "review" },
      { id: "child-done-parent", title: "child-done-parent", source_task_id: "parent-2", parent_status: "done" },
    ];

    expect(filterStartupReviewRecoveryRows(rows).map((row) => row.id)).toEqual(["root", "child-done-parent"]);
  });
});
