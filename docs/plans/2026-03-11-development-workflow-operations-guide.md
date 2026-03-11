# Development Workflow Operations Guide

## 목적

이 문서는 현재 `development` workflow를 운영하는 사람이

- 어디에서 상태를 확인해야 하는지
- 어떤 신호가 정상/이상인지
- 이상 신호를 보면 무엇부터 확인해야 하는지

를 빠르게 판단할 수 있게 정리한 운영 가이드다.

대상 범위는 `development` pack만이다.

## 현재 운영 표면

운영자가 주로 보는 화면은 네 군데다.

1. `Project Insights > Development Workflow Health`
2. `Project Insights > Effective Pack Preview`
3. `TaskReportPopup > Development Handoff`
4. `TaskReportPopup > Development Run Sheet`

각 표면의 역할은 분리해서 이해하는 것이 좋다.

- `Development Workflow Health`
  프로젝트 단위의 현재 건강 상태 요약
- `Effective Pack Preview`
  현재 프로젝트 workflow contract가 실제로 어떻게 해석됐는지 확인
- `Development Handoff`
  개별 task의 현재 인수인계 상태를 짧게 확인
- `Development Run Sheet`
  개별 task의 실행/검증/리뷰 근거를 자세히 확인

## 운영자가 보는 핵심 신호

### 1. Contract Status

프로젝트 workflow contract가 지금 어떤 상태로 해석되고 있는지 보여준다.

주요 필드:

- `preview_pack_key`
- `source`
- `override_applied`
- `last-known-good active`
- `warnings`

정상 신호:

- 기대한 pack이 잡혀 있다
- file override가 의도대로만 활성화되어 있다
- warning이 없거나 설명 가능한 수준이다

이상 신호:

- 예상과 다른 pack이 preview된다
- `last-known-good active`가 반복적으로 켜진다
- warning이 지속적으로 누적된다

우선 대응:

1. `WORKFLOW.md` 또는 `.claw-workflow.json` 문법 확인
2. `Effective Pack Preview`에서 warning과 source 확인
3. 최근 변경 이후부터 cache fallback이 켜졌는지 확인

### 2. Coverage

project-level run sheet 저장 상태를 본다.

주요 필드:

- `root_task_total`
- `stored_run_sheet_count`
- `synthetic_queued_count`
- `missing_persisted_run_sheet_count`

정상 해석:

- 실행 전 task가 있으면 `synthetic_queued_count`가 있을 수 있다
- 실행된 task는 가능한 한 `stored_run_sheet_count`에 잡혀야 한다

이상 신호:

- `missing_persisted_run_sheet_count > 0`

의미:

- 이미 실행/리뷰 단계인데 persisted run sheet가 없는 task가 있다는 뜻이다
- 현재 workflow instrumentation이 누락됐거나 비정상 종료가 있었을 수 있다

우선 대응:

1. `Attention Tasks`에서 해당 task를 연다
2. `TaskReportPopup`에 run sheet가 stored인지 synthetic인지 확인한다
3. task log에서 실행 시작/완료/리뷰 finalize 전환이 정상 기록됐는지 본다

### 3. Handoff States

현재 development root task들이 어느 전달 단계에 있는지 분포를 보여준다.

상태 의미:

- `queued`: 아직 실행 전
- `in_progress`: 구현/실행 중
- `review_ready`: 리뷰 진입 준비 완료
- `human_review`: 사람 확인 또는 PR feedback 대기
- `merging`: merge 수행 중
- `done`: 완료
- `rework`: 재작업 필요

운영 해석:

- `queued`는 신규 유입 또는 실행 대기
- `human_review`는 리뷰 대기 또는 PR gate block이 몰리는 구간
- `rework`가 많으면 품질 게이트 또는 실행 실패 패턴을 의심

### 4. PR Gate

GitHub PR feedback sweep 결과를 project 단위로 요약한 값이다.

주요 필드:

- `blocked`
- `passed`
- `skipped`
- `never_checked`
- `ignored_optional_checks_total`

운영 해석:

- `blocked` 증가: unresolved thread, `CHANGES_REQUESTED`, failing/pending check로 막힌 task 증가
- `passed` 증가: review finalize 직전 gate가 정상 통과
- `skipped` 증가: GitHub 프로젝트지만 검사 대상 open PR이 없는 경우
- `never_checked` 증가: review finalize까지 아직 가지 않은 task가 많거나 instrumentation 확인 필요
- `ignored_optional_checks_total` 증가: optional check ignore policy가 실제로 적용되고 있다는 뜻

주의할 점:

- `ignored_optional_checks_total` 자체는 이상이 아니다
- 값이 크더라도 실제 blocked가 낮고 merge 흐름이 건강하면 정상 운영일 수 있다

### 5. Attention Tasks

운영자가 가장 먼저 열어봐야 하는 task 목록이다.

우선순위는 현재 다음 순서다.

1. `pr_gate blocked`
2. `rework`
3. `human_review`
4. `pending_retry`
5. `missing persisted run sheet`

운영 원칙:

- project 점검은 항상 `Attention Tasks`에서 시작한다
- 먼저 가장 위 task 하나를 열고 `TaskReportPopup` 기준으로 원인을 본다

## 표면별 해석 가이드

### Project Insights

이 화면은 project-level triage 용도다.

먼저 볼 순서:

1. `Development Workflow Health`
2. `Effective Pack Preview`
3. `Attention Tasks`

추천 질문:

- 지금 이 프로젝트는 contract가 정상 해석되고 있는가?
- 실행 중인 root task들에 run sheet가 정상 저장되고 있는가?
- PR gate가 반복적으로 막히는가?
- 재작업/리뷰 대기가 특정 상태에 몰려 있는가?

### TaskReportPopup

이 화면은 single-task root cause 확인 용도다.

먼저 볼 순서:

1. `Development Handoff`
2. `Development Run Sheet`
3. `Quality Evidence`

추천 질문:

- 현재 state가 무엇인가?
- blocked라면 PR gate 때문인가, validation 때문인가?
- pending retry가 걸려 있는가?
- 마지막으로 저장된 review checklist와 validation evidence는 무엇인가?

## 대표 운영 시나리오

### 시나리오 A. `last-known-good active`가 보인다

뜻:

- 현재 workflow file을 그대로 쓰지 못하고 마지막 정상 snapshot을 사용 중이다

확인 순서:

1. `Effective Pack Preview` warning 확인
2. 프로젝트의 `WORKFLOW.md` / `.claw-workflow.json` 문법 확인
3. 최근 config 수정 내역 확인

대응:

- 문법을 고친 뒤 preview를 다시 확인
- cache active가 꺼지고 warning이 사라지는지 본다

### 시나리오 B. `missing persisted run sheet count`가 증가한다

뜻:

- 실행은 진행됐는데 stored run sheet가 없다

확인 순서:

1. `Attention Tasks`에서 해당 task 열기
2. `TaskReportPopup`에서 run sheet 존재 여부 확인
3. task log에서 execution start / run complete / review finalize 전환 확인

대응:

- instrumentation 누락인지 실제 비정상 종료인지 먼저 분류
- 동일 패턴이 반복되면 orchestration regression으로 취급

### 시나리오 C. `blocked`가 계속 쌓인다

뜻:

- PR feedback gate가 실질적으로 task 흐름을 막고 있다

확인 순서:

1. 해당 task의 `TaskReportPopup` 열기
2. `PR Gate` 상태, blocking reason, unresolved thread 수 확인
3. ignored optional checks가 있었는지도 같이 확인

대응:

- unresolved review thread / failing check 처리
- optional check가 blocking이면 ignore policy가 필요한지 검토

### 시나리오 D. `human_review`가 많이 쌓인다

뜻:

- 리뷰 대기, PR gate block, 수동 승인 대기가 몰리고 있을 수 있다

확인 순서:

1. `Attention Tasks` 상위 몇 개를 열어 원인이 같은지 확인
2. PR gate block인지 단순 human hold인지 구분

대응:

- 원인이 같으면 workflow 병목
- 원인이 제각각이면 task별 triage

## 일상 운영 체크리스트

### 일일 확인

1. `Project Insights`에서 `Attention Tasks` 상위 항목 확인
2. `missing persisted run sheet count`가 0인지 확인
3. `blocked`와 `never_checked` 추세 확인
4. `last-known-good active`가 새로 생긴 프로젝트가 있는지 확인

### 변경 직후 확인

아래 변경이 있었으면 바로 확인한다.

- `WORKFLOW.md`
- `.claw-workflow.json`
- review finalize 로직
- run sheet / handoff 갱신 로직
- PR gate policy

확인 포인트:

- preview pack/source가 예상대로인지
- `TaskReportPopup`에서 handoff/run sheet가 계속 보이는지
- PR gate가 과도하게 막히지 않는지

## 관련 문서

- [Symphony Workflow Adoption Plan](/C:/Users/NewPC/Downloads/claw-empire/docs/plans/2026-03-11-symphony-workflow-adoption-plan.md)
- [Development Workflow QA / Telemetry Checklist](/C:/Users/NewPC/Downloads/claw-empire/docs/plans/2026-03-11-development-workflow-qa-telemetry-checklist.md)

## 문서 사용 원칙

- 이 문서는 운영 기준 문서다
- 상세 재현 절차는 QA checklist 문서에 둔다
- 설계 배경과 phase 기록은 adoption plan 문서에 둔다

즉,

- `왜 이렇게 되었는가`는 adoption plan
- `무엇을 검증하는가`는 QA checklist
- `지금 무엇을 보고 어떻게 대응하는가`는 이 operations guide가 담당한다
