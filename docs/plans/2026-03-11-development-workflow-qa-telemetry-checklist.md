# Development Workflow QA / Telemetry Checklist

## 목적

`development` workflow의 운영 신호가 프로젝트 단위에서 일관되게 보이는지 검증한다.

확인 표면:
- `Project Insights > Development Workflow Health`
- `TaskReportPopup > Development Handoff`
- `TaskReportPopup > Development Run Sheet`
- `Effective Pack Preview`

## 시나리오 1. 정상 development task

### 재현 방법

1. `development` root task를 생성한다.
2. 실행을 시작해 run sheet가 저장되게 한다.
3. 리뷰 준비 상태로 넘긴다.
4. 리뷰 완료 후 `done`까지 종료한다.

### 확인 위치

- `TaskReportPopup`
- `ProjectInsightsPanel`

### 기대 신호

- `TaskReportPopup`에서 run sheet가 `in_progress -> review_ready -> done`으로 전이된다.
- `Development Handoff`도 같은 흐름으로 갱신된다.
- `ProjectInsightsPanel`의 `Handoff States`와 `Coverage`가 최신 상태를 반영한다.
- `stored run sheet count`가 증가하고 `missing persisted run sheet count`는 증가하지 않는다.

## 시나리오 2. PR gate blocked

### 재현 방법

1. GitHub 연동 프로젝트의 `development` task를 리뷰 단계까지 진행한다.
2. 열린 `dev -> main` PR에 unresolved review thread 또는 failing check를 남긴다.
3. 리뷰 완료를 시도한다.

### 확인 위치

- `TaskReportPopup`
- `ProjectInsightsPanel`

### 기대 신호

- `TaskReportPopup`의 PR gate 요약이 `blocked`를 표시한다.
- `Development Handoff`는 `human_review` 상태로 유지된다.
- `ProjectInsightsPanel`의 `PR Gate > blocked`가 증가한다.
- `Attention Tasks` 최상단에 해당 task가 노출된다.

## 시나리오 3. optional check ignored

### 재현 방법

1. `WORKFLOW.md` 또는 `.claw-workflow.json`에 `developmentPrFeedbackGate.ignoredCheckNames` 또는 `ignoredCheckPrefixes`를 설정한다.
2. ignore 대상 check 하나와 blocking check가 아닌 optional check 하나를 PR head에 남긴다.
3. 리뷰 완료를 다시 시도한다.

### 확인 위치

- `TaskReportPopup`
- `ProjectInsightsPanel`

### 기대 신호

- `TaskReportPopup` PR gate 요약에 ignored check 수와 이름이 보인다.
- `ProjectInsightsPanel`의 `Ignored Optional Checks` 합계가 증가한다.
- ignore 대상만 남아 있으면 gate는 `passed` 또는 `skipped`로 유지되고 task가 불필요하게 막히지 않는다.

## 시나리오 4. synthetic queued -> stored run sheet 전환

### 재현 방법

1. 실행 전 `development` root task를 하나 만든다.
2. 아직 실행하지 않은 상태에서 프로젝트 상세를 연다.
3. 그 task를 실행해 persisted run sheet가 생성되게 한다.
4. 프로젝트 상세를 새로고침한다.

### 확인 위치

- `ProjectInsightsPanel`
- `TaskReportPopup`

### 기대 신호

- 실행 전에는 `synthetic queued count`가 증가한다.
- 실행 후에는 `stored run sheet count`가 증가하고 `synthetic queued count`는 감소한다.
- `TaskReportPopup`에서는 synthetic queued가 아니라 저장된 run sheet가 보인다.

## 시나리오 5. invalid WORKFLOW.md + last-known-good

### 재현 방법

1. 정상 `WORKFLOW.md` 상태에서 Effective Pack Preview를 한 번 열어 cache를 워밍한다.
2. `WORKFLOW.md`를 invalid YAML 또는 읽을 수 없는 상태로 만든다.
3. 프로젝트 상세를 다시 연다.
4. 필요하면 task 실행 또는 review finalize 경로도 한 번 수행한다.

### 확인 위치

- `Effective Pack Preview`
- `ProjectInsightsPanel`
- runtime 경로의 실제 task 실행 결과

### 기대 신호

- `Effective Pack Preview`와 `ProjectInsightsPanel`의 contract status에 `last-known-good active`가 표시된다.
- warning에 parse/read failure와 cache 적용 사실이 함께 표시된다.
- runtime은 마지막 정상 policy markdown, hook override, PR gate policy를 계속 사용한다.

## 운영 체크 포인트

- `missing persisted run sheet count`가 0이 아닌 프로젝트는 우선 점검한다.
- `PR Gate blocked`가 장시간 유지되는 task는 `Attention Tasks`에서 먼저 확인한다.
- `last-known-good active`가 반복적으로 보이는 프로젝트는 workflow file 관리 상태를 점검한다.
- `never checked`가 많은 GitHub 프로젝트는 review finalize 경로가 실제로 거치는지 확인한다.
