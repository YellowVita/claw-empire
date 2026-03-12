# Phase 1 Plan Execution: Prevent task pollution on merge failure

- [x] `server/modules/workflow/orchestration/review-finalize-tools.ts` 수정
  - merge 실패 시 `return` 처리하여 성공 로직(done 전이 등) 실행 방지
  - 실패 경로에서 `stage`를 `human_review`로 복구하고 task update/task report refresh 수행
- [x] `server/modules/workflow/orchestration/development-handoff.ts` 수정
  - merge 실패 상태일 때 summary를 `"Merge failed; manual resolution required"`로 우선 노출
- [x] 결과 테스트: 병합 충돌 시 `done` 상태로 넘어가지 않는지, UI 상에 merge 실패가 잘 표시되는지 확인
  - server workflow regression tests 통과
  - TaskReportPopup component tests 통과

# Phase 2 Plan Execution: 승인 후 auto-commit 감사 정합성 보강

- [x] `workflow_meta_json`에 `development_review_audit` 부분 patch helper 추가
  - 승인 시각/승인 출처/auto-commit SHA/post-merge HEAD SHA 저장
  - 기존 `development_handoff` 및 다른 sibling metadata 보존
- [x] `shared.ts` / `merge.ts` 감사 반환값 확장
  - auto-commit `commitSha?`
  - merge 결과 `autoCommitSha?`, `postMergeHeadSha?`, `targetBranch?`
- [x] `review-finalize-tools.ts`에서 승인/merge 감사 기록
  - review consensus / delegated child finalize 각각 approval source 기록
  - merge 실패 시 감사 정보 보존, 성공 시 merge SHA 확정
- [x] `task-run-sheets.ts` / 프런트 타입 / `TaskReportPopup.tsx` 감사 정보 노출
  - review_checklist audit 필드 추가
  - run sheet markdown 및 UI 카드 렌더링
- [x] 테스트 및 정책 문구 정리
  - git helper / review finalize / UI regression
  - `AGENTS.md` Git Safety Rule 예외 문구 갱신
  - server workflow/task-report tests 통과
  - TaskReportPopup component tests 통과
