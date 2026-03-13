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

# Phase 3 Plan Execution: CI fast/full gate 분리

- [x] workflow 분리
  - `.github/workflows/ci-fast.yml`
  - `.github/workflows/ci-full.yml`
  - 기존 단일 `ci.yml` 제거
- [x] `package.json` 스크립트 계층화
  - `typecheck`, `ci:fast`, `ci:full` 추가
  - `test:ci`를 `ci:full` alias로 유지
  - `openapi:check` 중복 제거
- [x] 문서/운영 가이드 정리
  - `README.md` CI 설명 및 badge 갱신
  - `.github/pull_request_template.md` 체크리스트 갱신
  - `CONTRIBUTING.md` branch protection guidance 갱신
- [x] 검증
  - `pnpm run ci:fast`
  - 스크립트/문서/워크플로 정합성 확인
  - `ci:fast`는 기존 저장소 전반의 Prettier 불일치(92 files) 때문에 `format:check`에서 중단됨
  - `pnpm run typecheck` 통과
  - `pnpm run build` 통과
  - 변경 파일 대상 `prettier --check` 통과

# Phase 4 Plan Execution: auto git bootstrap opt-in 전환

- [x] 프로젝트 정책 `gitBootstrap.allowAutoGitBootstrap` 추가
  - `WORKFLOW.md > .claw-workflow.json` 우선순위 유지
  - invalid/missing schema는 `false`로 안전 fallback
- [x] worktree lifecycle 반환 타입 구조화
  - `createWorktree()`가 `success/worktreePath/failureCode/message`를 반환
  - `git_bootstrap_disabled` 실패 시 수동 Git 초기화 명령 제공
- [x] 실행 경로 메시지 분기
  - execution run / orchestration / spawn / delegated launch가 같은 failure code를 공유
  - bootstrap disabled일 때는 manual git init 안내를 노출
- [x] 테스트 및 문서 보정
  - project-config / lifecycle / execution-run regression 추가
  - release / operations guide에 opt-in 정책 반영
