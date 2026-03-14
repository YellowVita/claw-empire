# Dev Proxy Recovery

- [x] `vite` 프록시와 API 바인딩 경로를 재현해서 실제 장애 지점을 분리
- [x] `server/modules/lifecycle.ts`에서 런타임 `HOST`가 `undefined`로 덮어써지는 문제 수정
- [x] `vite.config.ts`에서 `ECONNABORTED` 프록시 소음을 무시하도록 보강
- [x] 프록시/브라우저/타입체크로 정상 동작 재검증

## Review Results

- 원인: `startLifecycle()`가 `ctx.HOST`를 구조분해해 설정 파일의 `HOST` 상수를 가려버렸고, 그 결과 API가 `127.0.0.1` 대신 `undefined`로 listen 하면서 dev 프록시가 `502 Bad Gateway`를 반환함
- 수정: `app.listen()`과 기동 로그가 `server/config/runtime.ts`의 실제 `HOST` 값을 사용하도록 정리
- 추가 보정: Vite 프록시가 개발 중 소켓 중단에서 `ECONNABORTED`를 불필요하게 에러 로그로 남기지 않도록 무시 코드 추가
- 검증:
  - `http://127.0.0.1:8800/api/health` => `200`
  - `http://127.0.0.1:8800/api/auth/session` => `200`
  - API listen 주소가 `127.0.0.1:8790`으로 복구된 것 확인
  - Playwright로 메인 화면이 로딩 화면에서 벗어나 실제 오피스 화면까지 렌더링되는 것 확인
  - `pnpm run typecheck` 통과

# Owner-Integrate Internal Worker Separation

- [x] `createSubtaskFromCli` source 메타 추가 및 `owner_integrate` 내부 워커 skip 처리
- [x] `cli-runtime`에서 Claude/Codex 내부 워커 source 전달 및 thread mapping 재검증 추가
- [x] owner integration 지시문 강화
- [x] 회귀 테스트 추가 및 타깃 검증 실행

## Review Results

- `owner_integrate` 단계에서 `claude_task`, `codex_spawn_agent`는 공식 `subtasks` 생성 없이 로그만 남기도록 변경
- `spawn_agent item.completed`는 DB에 실제 subtask가 존재할 때만 `codexThreadToSubtask`를 매핑하도록 보강
- `http_plan`, `gemini_plan` 기반의 선언적 subtask 생성은 기존 동작 유지
- 검증
  - `pnpm exec vitest --config server/vitest.config.ts run server/modules/workflow/agents/subtask-seeding.test.ts server/modules/workflow/agents/cli-runtime.test.ts server/modules/workflow/orchestration/subtask-orchestration-v2.test.ts` 통과
  - `pnpm run typecheck` 통과

# V2 Internal Worker Delegation Scope Expansion

- [x] V2 전 단계에서 내부 워커의 외부 부서 승격 차단으로 일반화
- [x] 관련 회귀 테스트를 `owner_prep`/비-V2 범위까지 보강

## Review Results

- `createSubtaskFromCli`는 이제 `owner_integrate` 한정이 아니라 `V2 전체`에서 내부 워커(`claude_task`, `codex_spawn_agent`)의 외부 부서 승격을 차단
- 차단 조건은 `V2 + 내부 워커 + foreign department 라우팅`이며, 비-V2와 선언적 plan 생성은 유지
- 검증
  - `pnpm exec vitest --config server/vitest.config.ts run server/modules/workflow/agents/subtask-seeding.test.ts server/modules/workflow/agents/cli-runtime.test.ts server/modules/workflow/orchestration/subtask-orchestration-v2.test.ts` 통과
  - `pnpm run typecheck` 통과

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

# Phase 5 Plan Execution: GitHub merge strategy 옵션화

- [x] 프로젝트 정책 `mergeStrategy.mode` 추가
  - `shared_dev_pr` 기본값 유지
  - `WORKFLOW.md > .claw-workflow.json` 우선순위 및 invalid fallback 적용
- [x] GitHub merge helper 전략 분리
  - `shared_dev_pr`: 기존 `dev -> main` shared PR 경로 유지
  - `task_branch_pr`: task branch push + `task branch -> dev` PR 생성/갱신
- [x] PR gate selector 일반화 및 전략별 동작 분리
  - `shared_dev_pr`는 blocker
  - `task_branch_pr`는 observational
- [x] 감사/리포트/UI 반영
  - `development_review_audit`, run sheet, handoff, TaskReportPopup에 `merge_strategy` / `pr_url` 반영
- [x] 검증
  - `pnpm run typecheck` 통과
  - server workflow/task-report regression tests 통과
  - `TaskReportPopup` component tests 통과

# Upstream v2.0.4 Merge Assessment

- [x] 원본 `GreenSheep01201/claw-empire`를 `upstream` 리모트로 정리하고 `v2.0.4` fetch
- [x] `main` 기준 통합용 브랜치 `codex/merge-upstream-v2.0.4` 생성
- [x] `upstream`의 `v2.0.4`를 `--no-commit --no-ff`로 머지 시뮬레이션
- [x] 충돌 파일과 비충돌 변경 파일을 분류하고 핵심 리스크 요약
- [x] 작업트리를 원상복구하고 안전한 통합 절차 제안

## Review Results

- `main...upstream/main` 기준 분기 상태: 로컬 포크가 63커밋 선행, 원본이 42커밋 선행
- 실제 `git merge --no-commit --no-ff v2.0.4` 시 직접 충돌 5건 확인
  - `README.md`
  - `server/modules/lifecycle.ts`
  - `server/modules/workflow/orchestration/report-workflow-tools.ts`
  - `src/components/settings/types.ts`
  - `tests/e2e/ci-api-ops-and-docs.spec.ts`
- 자동 병합된 변경은 다수였고, 범위는 Docker 배포, API preset/Kimi provider, lifecycle recovery, API assignment, E2E cleanup까지 확장됨
- 작업트리는 `git merge --abort`로 복구했고, 현재 남은 로컬 변경은 이 `tasks/todo.md` 기록뿐

# Upstream v2.0.4 Merge Integration

- [x] 통합 브랜치 `codex/merge-upstream-v2.0.4`에서 `v2.0.4` 머지 재실행
- [x] 충돌 파일 5개 수동 해소
- [x] 타입/빌드/테스트로 통합 검증
- [x] 결과 요약 및 `main` 반영 절차 정리

## Review Results

- 충돌 해소 파일
  - `README.md`
  - `server/modules/lifecycle.ts`
  - `server/modules/workflow/orchestration/report-workflow-tools.ts`
  - `src/components/settings/types.ts`
  - `tests/e2e/ci-api-ops-and-docs.spec.ts`
- 추가 통합 작업
  - `server/modules/lifecycle/orphan-working-agent-recovery.ts` 추가
  - `server/modules/lifecycle/orphan-working-agent-recovery.test.ts` 추가
  - `server/db/queries/agent-queries.ts`에 stale working agent 조회/조건부 해제 쿼리 추가
  - `server/modules/routes/core/tasks/execution-run.test.ts` 타입 보정
- 검증
  - `pnpm run typecheck` 통과
  - `pnpm exec vitest --config server/vitest.config.ts run server/modules/lifecycle/orphan-working-agent-recovery.test.ts server/modules/lifecycle/startup-orphan-worktree-cleanup.test.ts server/modules/lifecycle/review-recovery.test.ts` 통과
  - `pnpm run build` 통과
  - `pnpm run test:e2e` 실패: `scripts/run-e2e.mjs` 단계에서 `spawn EINVAL`

# E2E Spawn EINVAL Fix

- [x] `scripts/run-e2e.mjs`의 Windows spawn 실패 최소 재현
- [x] 원인에 맞는 런처 수정
- [x] `pnpm run typecheck`, `pnpm run build`, `pnpm run test:e2e` 재검증

## Review Results

- 원인: Windows에서 `child_process.spawn('pnpm.cmd', ...)`가 즉시 `EINVAL`로 실패
- 수정: `scripts/run-e2e.mjs`가 Windows에서 `.cmd`를 직접 spawn하지 않고 `cmd.exe /d /s /c ...`로 실행하도록 변경
- 추가 수정: `tests/e2e/ci-api-ops-and-docs.spec.ts`에 `cleanupE2EResources` import 복구
- 검증
  - `pnpm run typecheck` 통과
  - `pnpm run build` 통과
  - `pnpm run test:e2e -- --list` 통과
  - `pnpm exec playwright install chromium` 실행
  - `pnpm run test:e2e` 통과

# Review Queue Cleanup

- [x] `review`에 남아 있는 delegated task/worktree를 `main` 기준으로 분류
- [x] 이미 상위 통합본에 반영된 브랜치는 `discard`로 정리
- [x] 추가 반영이 필요한 브랜치는 별도 보류 사유를 남기고 보고

## Review Results

- 상위 완료 태스크 `2375e68e-0fa5-4719-8388-61f59fe354dd` 로그에서 delegated child 7건이 부모 완료 시점에 논리적으로 닫힌 상태임을 확인
- 남아 있던 `review` 태스크 7건은 모두 문서 보완용 delegated collaboration branch였고, 공통적으로 `Merge failed; manual resolution required` 상태였음
- 각 태스크는 `discard`로 워크트리/브랜치를 정리한 뒤 `done` + `hidden=1`로 전환
- 정리 후 검증 결과
  - `/api/tasks?status=review` => 0건
  - `/api/worktrees` => 0건

# Prompt-Workflow Alignment

- [x] `server/modules/workflow/core/project-context-tools.ts` 실행 정책 블록에 계획/검증 계약 추가
- [x] `server/modules/workflow/orchestration/execution-start-task.ts` worktree 안내 문구를 no-commit 정책으로 교체
- [x] `server/modules/workflow/core/meeting-prompt-tools.ts` 회의 타입별 출력 규칙 분기
- [x] prompt builder unit tests 추가 및 회귀 확인

## Review Results

- 실행 공통 정책에 `Planning & Verification Contract` 블록 추가
- isolated worktree 안내에서 일반 커밋 허용 문구 제거, no-commit + test/user-approval 조건 명시
- `planned` 회의는 1~3문장 유지, `review` 회의는 2~5문장 + 결론/근거/다음 액션 규칙 추가
- 검증
  - `pnpm exec vitest --config server/vitest.config.ts run server/modules/workflow/core/project-context-tools.test.ts server/modules/workflow/core/meeting-prompt-tools.test.ts` 통과
  - `pnpm run typecheck` 통과

# Development Pack V2 Orchestration Alignment

- [x] `POST /api/tasks`의 development 루트 태스크를 V2 owner_prep으로 생성
- [x] direct-chat task 생성 경로를 동일 규칙으로 정렬
- [x] legacy development 루트 태스크 lazy migration 추가
- [x] 관련 테스트 추가 및 타깃 검증 실행

## Review Results

- `POST /api/tasks`와 direct-chat task 생성 경로에서 `development` 루트 태스크에 `orchestration_version=2`, `orchestration_stage='owner_prep'`를 기본 저장하도록 변경
- `subtask-delegation`에 legacy development root task lazy migration 추가
  - `review` 상태면 `review`
  - `owner_prep` blocker가 남아 있으면 `owner_prep`
  - blocker가 없고 foreign subtask가 남아 있으면 `foreign_collab`
  - foreign 없이 owner-integrate subtask만 남아 있으면 `owner_integrate`
- `PATCH /api/tasks` 동작은 바꾸지 않았고, lazy migration은 위임 시점에만 수행
- 검증
  - `pnpm exec vitest --config server/vitest.config.ts run server/modules/routes/core/tasks/crud.workflow-pack-filter.test.ts server/modules/routes/collab/direct-chat-task-flow.pack-inference.test.ts server/modules/routes/collab/subtask-delegation.v2.test.ts server/modules/routes/collab/task-delegation.skip-v2.test.ts` 통과
  - `pnpm run typecheck` 통과

# Owner Integrate Stall Investigation

- [x] `owner_integrate` 서브태스크 생성부터 실행 트리거까지의 코드 경로 확인
- [x] 현재 멈춘 루트 태스크 `490b8eda-753b-47d5-a307-7d4cda5c4657`의 재개 가능 경로 확인
- [x] 재발 원인 수정 또는 운영상 우회 조치 적용
- [x] 회귀 테스트와 실제 DB/상태 조회로 검증

## Review Results

- 원인 1: V2 루트 태스크가 `review` 상태에서 `owner_integrate` 서브태스크를 기다릴 때, `processSubtaskDelegations()`가 `foreign_collab -> owner_integrate` 전환만 처리하고 `review -> owner_integrate` 복귀를 처리하지 못함
- 원인 2: `listPendingDelegationParentTaskIds()`가 `review` 단계의 V2 루트 태스크를 sweep 대상으로 포함하지 않아, 서버 재시작/주기 sweep으로도 정지 상태를 복구하지 못함
- 수정:
  - `server/modules/routes/collab/subtask-delegation.ts`
    - `review` 단계에서 foreign 협업이 끝나고 `owner_integrate`만 남은 경우 `owner_integrate`로 승격 후 owner 실행 재개
    - 즉시 완료 감지 경로(`maybeNotifyAllSubtasksComplete`)도 동일 규칙 반영
  - `server/db/queries/task-queries.ts`
    - `review` 상태이면서 `foreign_collab`/`owner_integrate`/`finalize` 성격의 미완료 서브태스크가 남은 V2 루트 태스크를 delegation sweep 대상에 포함
  - 테스트 추가:
    - `server/db/queries/task-queries.test.ts`
    - `server/modules/routes/collab/subtask-delegation.v2.test.ts`
- 검증:
  - `pnpm exec vitest --config server/vitest.config.ts run server/db/queries/task-queries.test.ts server/modules/routes/collab/subtask-delegation.v2.test.ts` 통과
  - 실제 실행 중 서버(nodemon)가 패치 후 재시작되며 stalled task `490b8eda-753b-47d5-a307-7d4cda5c4657`가 `in_progress / owner_integrate`로 자동 복귀
