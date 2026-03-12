import { describe, expect, it } from "vitest";

import {
  getLegacyForeignDelegationReadiness,
  inferOrchestrationPhaseFromSubtask,
} from "./subtask-orchestration-v2.ts";

describe("subtask orchestration v2 helpers", () => {
  it("prefers explicit orchestration_phase over title and target fallbacks", () => {
    expect(
      inferOrchestrationPhaseFromSubtask({
        title: "부서 산출물 통합 및 최종 정리",
        target_department_id: "qa",
        orchestration_phase: "owner_prep",
      }),
    ).toBe("owner_prep");
  });

  it("treats only owner_prep owner-side subtasks as legacy foreign delegation blockers", () => {
    const readiness = getLegacyForeignDelegationReadiness(
      { department_id: "planning" },
      [
        { title: "부서 산출물 통합 및 최종 정리", status: "pending", target_department_id: null, orchestration_phase: "owner_integrate" },
        { title: "QA deliverable", status: "pending", target_department_id: "qa", orchestration_phase: "foreign_collab" },
      ],
    );

    expect(readiness).toEqual({
      ready: true,
      ownerPrepBlockerCount: 0,
      ownerSideOpenCount: 1,
      ownerIntegrateOpenCount: 1,
    });
  });

  it("keeps generic phase-less owner subtasks as conservative owner_prep blockers", () => {
    const readiness = getLegacyForeignDelegationReadiness(
      { department_id: "dev" },
      [
        { title: "owner work", status: "pending", target_department_id: null },
        { title: "qa work", status: "pending", target_department_id: "qa" },
      ],
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.ownerPrepBlockerCount).toBe(1);
  });
});
