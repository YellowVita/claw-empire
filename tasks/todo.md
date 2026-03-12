# Phase 1 Plan Execution: Prevent task pollution on merge failure

- [x] `server/modules/workflow/orchestration/review-finalize-tools.ts` 수정
  - merge 실패 시 `return` 처리하여 성공 로직(done 전이 등) 실행 방지
  - 실패 경로에서 `stage`를 `human_review`로 복구하고 task update/task report refresh 수행
- [x] `server/modules/workflow/orchestration/development-handoff.ts` 수정
  - merge 실패 상태일 때 summary를 `"Merge failed; manual resolution required"`로 우선 노출
- [x] 결과 테스트: 병합 충돌 시 `done` 상태로 넘어가지 않는지, UI 상에 merge 실패가 잘 표시되는지 확인
  - server workflow regression tests 통과
  - TaskReportPopup component tests 통과
