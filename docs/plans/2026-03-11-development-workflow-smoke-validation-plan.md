# Development Workflow Smoke Validation Plan

## 목적

`development` workflow의 주요 신호가 실제 프로젝트에서 운영자 관점으로 정상적으로 보이는지 검증한다.

이 문서는 기능 구현 검증이 아니라 실운영 스모크 점검 계획이다.

즉, 목표는 다음 두 가지다.

1. 현재 project-level telemetry가 실제 triage에 도움이 되는지 확인
2. noisy signal, 누락된 신호, 잘못된 우선순위를 실제 프로젝트 기준으로 찾기

## 범위

이번 스모크 검증은 아래 범위만 다룬다.

- `Project Insights > Development Workflow Health`
- `Project Insights > Effective Pack Preview`
- `TaskReportPopup > Development Handoff`
- `TaskReportPopup > Development Run Sheet`

이번 범위에 포함하지 않는 것:

- 전사 대시보드
- 장기 추세 분석
- 새로운 telemetry 저장소 추가
- 자동화된 end-to-end 테스트 추가

## 대상 프로젝트 선정 기준

실제 프로젝트는 2~3개만 고른다.

권장 구성:

### 프로젝트 A. 정상 development 흐름이 있는 프로젝트

조건:

- 최근 `development` root task가 실제로 실행된 프로젝트
- run sheet가 저장된 task가 최소 1개 이상 있는 프로젝트

목적:

- 정상 handoff / run sheet / project health 신호 확인

### 프로젝트 B. GitHub PR gate가 의미 있는 프로젝트

조건:

- `github_repo`가 설정된 프로젝트
- 최근 review 또는 PR gate quality run이 있는 프로젝트

목적:

- `blocked / passed / skipped / never_checked`
- ignored optional checks
- attention task 우선순위

### 프로젝트 C. contract fallback 확인이 가능한 프로젝트

조건:

- `WORKFLOW.md` 또는 `.claw-workflow.json`을 실제로 사용하는 프로젝트
- `Effective Pack Preview`를 통해 last-known-good 여부를 확인할 수 있는 프로젝트

목적:

- contract status와 runtime fallback 신호 확인

주의:

- 세 조건을 하나의 프로젝트가 동시에 만족하면 2개 프로젝트만으로 진행해도 된다.

## 실행 순서

각 프로젝트마다 아래 순서로 확인한다.

1. `Project Insights` 진입
2. `Development Workflow Health` 확인
3. `Effective Pack Preview` 확인
4. `Attention Tasks` 상위 1~3개 열기
5. 각 task의 `TaskReportPopup`에서 `Development Handoff`와 `Development Run Sheet` 확인

이 순서를 고정하는 이유:

- project-level 신호와 task-level 원인을 바로 연결할 수 있기 때문이다.

## 필수 검증 시나리오

### 시나리오 1. 정상 development task

확인 목표:

- run sheet 저장
- handoff 상태 전이
- project health coverage 반영

통과 기준:

- 실행된 task가 stored run sheet를 가진다
- `TaskReportPopup`에서 `in_progress -> review_ready -> done` 또는 그에 준하는 정상 흐름이 보인다
- `Project Insights`의 `stored_run_sheet_count`가 실제 task 상태와 맞는다

실패 신호:

- 실행된 task인데 run sheet가 없다
- handoff와 run sheet stage가 서로 어긋난다

### 시나리오 2. PR gate blocked

확인 목표:

- blocked 상태가 project와 task 양쪽에 일관되게 드러나는지 확인

통과 기준:

- `TaskReportPopup`에서 PR gate가 `blocked`로 보인다
- `Development Handoff`가 `human_review`에 머문다
- `Project Insights`의 `blocked_count`가 증가한다
- 해당 task가 `Attention Tasks` 상위에 노출된다

실패 신호:

- task는 blocked인데 project summary는 반영되지 않는다
- `Attention Tasks` 우선순위가 낮아서 묻힌다

### 시나리오 3. optional check ignored

확인 목표:

- optional check ignore policy가 운영 신호에 반영되는지 확인

통과 기준:

- task report에서 ignored check 수와 이름이 보인다
- project health의 `ignored_optional_checks_total`이 증가한다
- ignore 대상만 남은 경우 불필요한 blocked가 생기지 않는다

실패 신호:

- ignore policy가 적용됐는데 집계가 0으로 남는다
- ignore 대상이 여전히 blocked reason으로 잡힌다

### 시나리오 4. synthetic queued -> stored run sheet 전환

확인 목표:

- 실행 전/후 coverage 지표가 자연스럽게 바뀌는지 확인

통과 기준:

- 실행 전에는 `synthetic_queued_count`에 잡힌다
- 실행 후에는 same task가 stored run sheet로 전환된다
- `missing_persisted_run_sheet_count`는 증가하지 않는다

실패 신호:

- 실행 후에도 synthetic queued로 남아 있다
- 실행 후 stored run sheet가 없고 missing persisted로 넘어간다

### 시나리오 5. invalid workflow contract + last-known-good

확인 목표:

- contract fallback 신호가 운영자에게 명확한지 확인

통과 기준:

- `Effective Pack Preview`와 project health contract status에 `last-known-good active`가 보인다
- warning에 parse/read failure와 cache 적용이 함께 보인다
- 실제 runtime은 마지막 정상 policy를 계속 사용한다

실패 신호:

- preview는 정상인데 runtime이 무너진다
- cache active는 켜졌는데 운영자가 어디서도 구분할 수 없다

## 증거 수집 방식

각 프로젝트마다 아래를 기록한다.

### 1. 프로젝트 요약

- 프로젝트 이름
- 프로젝트 경로
- 확인 날짜
- 확인자

### 2. Project-level 신호

- contract status
- coverage 수치
- handoff state 분포
- PR gate 요약
- attention tasks 상위 항목

### 3. Task-level 샘플

최소 1~3개 task에 대해:

- task 제목
- current handoff state
- run sheet stage
- PR gate 상태
- pending retry 여부
- 이상 여부

### 4. 판정

각 프로젝트별로 아래 셋 중 하나로 판정한다.

- `pass`
- `pass_with_tuning`
- `fail`

판정 기준:

- `pass`: 신호가 운영 판단에 충분하고 치명적 누락이 없음
- `pass_with_tuning`: 기능은 맞지만 우선순위/표현/소음 조정 필요
- `fail`: 상태 누락, 잘못된 집계, 잘못된 우선순위로 운영 판단을 방해

## 후속 액션 규칙

### `pass`

- 별도 코드 수정 없이 운영 기준 유지

### `pass_with_tuning`

- 작은 후속 작업으로 분리한다
- 예:
  - `Attention Tasks` 정렬 조정
  - warning 축약
  - label 개선

### `fail`

- 운영 하드닝 이슈로 바로 승격한다
- 우선순위는 다음 기준으로 정한다
  - triage 실패를 유발하는가
  - project-level 수치와 task-level reality가 어긋나는가
  - blocked/rework 판단을 잘못 유도하는가

## 권장 결과물

스모크 검증을 실제로 수행할 때는 결과를 별도 운영 메모로 남긴다.

권장 형식:

- 프로젝트별 1문단 요약
- 발견 이슈 목록
- 바로 수정할 것 / 지켜볼 것 분리

## 관련 문서

- [Development Workflow Operations Guide](/C:/Users/NewPC/Downloads/claw-empire/docs/plans/2026-03-11-development-workflow-operations-guide.md)
- [Development Workflow QA / Telemetry Checklist](/C:/Users/NewPC/Downloads/claw-empire/docs/plans/2026-03-11-development-workflow-qa-telemetry-checklist.md)
- [Symphony Workflow Adoption Plan](/C:/Users/NewPC/Downloads/claw-empire/docs/plans/2026-03-11-symphony-workflow-adoption-plan.md)

## 한 줄 운영 원칙

이번 스모크 검증의 목적은 “기능이 있다”를 다시 확인하는 것이 아니다.

목적은 “운영자가 실제 프로젝트 하나를 열었을 때, 지금 무엇이 문제인지 빠르게 판단할 수 있는가”를 확인하는 것이다.
