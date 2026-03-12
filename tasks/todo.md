# Project Analysis Plan

## 1. Frontend Review
- [x] Check React 19 / Vite / Tailwind v4 patterns and component structure
- [x] Analyze State Management (Contexts vs Global)
- [x] Verify UI/UX guidelines conformity (tools/taste-skill/skill.md)

## 2. Backend Review
- [x] Inspect Express server structure and middleware
- [x] Review DB interactions (SQLite, transaction handling)
- [x] Check API routes and separation of concerns

## 3. General Code Quality
- [x] Performance optimizations (e.g. redundant re-renders, DB locks)
- [x] Typescript strictness and security practices

## 4. Final Output
- [x] Summarize findings into a comprehensive Korean response

## 5. Peer Feedback Delivery Doc
- [x] Re-verify `tasks/analysis_report.md` claims against actual code paths
- [x] Separate valid findings from incorrect or overstated conclusions
- [x] Create a developer-facing feedback memo in `tasks/analysis_report_peer_feedback.md`
- [x] Record the review outcome in this checklist

## 6. Symphony Workflow Comparison Doc
- [x] Compare `claw-empire` development workflow against `symphony`
- [x] Decide which Symphony ideas are worth adopting vs rejecting
- [x] Save the recommendation as a project design document under `docs/plans`

## 7. Development Workflow Contract Phase 1
- [x] Add `WORKFLOW.md` project workflow contract loading with `.claw-workflow.json` fallback
- [x] Merge default pack, pack overrides, and task execution hooks with `WORKFLOW.md` precedence
- [x] Inject `WORKFLOW.md` policy Markdown only into `development` runtime prompt sections
- [x] Extend effective workflow pack API with policy/source inspection fields
- [x] Add regression tests and run targeted API/UI tests plus full build verification

## 8. Development Run Sheet Phase 2
- [x] Add `task_run_sheets` schema/migration and server-side storage helpers
- [x] Build deterministic development run sheet snapshot + markdown renderer
- [x] Upsert run sheets from execution start, run completion, and review finalization
- [x] Extend task report API/types with stored and synthetic queued run sheets
- [x] Render development run sheet in `TaskReportPopup`
- [x] Add regression tests and run targeted server/UI verification plus build

## 9. Development PR Feedback Gate Phase 3
- [x] Extract shared GitHub auth helper and add PR feedback gate inspection logic
- [x] Block `development` review finalization on unresolved PR feedback or failing/pending checks
- [x] Persist gate outcomes via quality runs and expose them through development run sheets
- [x] Render PR gate status in `TaskReportPopup`
- [x] Add regression tests and run targeted server/UI verification plus build

## 10. Development Handoff Metadata Phase 4
- [x] Add shared `development_handoff` metadata helper and preserve existing `workflow_meta_json` keys
- [x] Expose normalized `development_handoff` on task and task-report API payloads
- [x] Update development handoff metadata across task lifecycle milestones
- [x] Render development handoff summary in `TaskBoard` and `TaskReportPopup`
- [x] Add regression tests and run targeted server/UI verification plus build

## 11. Development PR Gate Optional-Check Tuning Phase 5
- [x] Add project workflow config support for `developmentPrFeedbackGate` ignored check policies
- [x] Extend GitHub PR gate helper to ignore exact/prefix-matched check names and contexts
- [x] Pass project policy into review finalization and persist ignored check details in run sheets/quality runs
- [x] Render ignored optional-check details in `TaskReportPopup`
- [x] Add regression tests and run targeted server/UI verification plus build

## 12. Workflow Contract Last-Known-Good Phase 6
- [x] Add DB-backed last-known-good cache wrapper for project workflow config loading
- [x] Extend effective workflow preview/API with cache status metadata
- [x] Switch runtime callers to the cached project workflow config loader
- [x] Show cache-applied state in Project Insights effective preview
- [x] Add regression tests and run targeted server/UI verification plus build

## 13. Development Workflow QA / Telemetry
- [x] Add project-level development workflow health summary to project detail route
- [x] Extend project detail API/types and Project Insights UI with workflow health telemetry
- [x] Add project health aggregation regression tests plus Project Insights UI coverage
- [x] Add operator QA checklist document for development workflow validation
- [x] Run targeted server/UI verification plus build

## 14. Subtask Department Misrouting Fix
- [x] Prioritize explicit role labels like `QA팀장` over generic implementation keywords
- [x] Apply the same routing rule to CLI-created subtasks and startup repair for active misrouted rows
- [x] Add regression tests for routing, CLI creation, and repair behavior
- [x] Run targeted server tests plus build verification

## 15. Development Workflow Operations Doc
- [x] Write an operator-facing development workflow operations guide
- [x] Link current runtime surfaces, signals, and response playbooks in one document
- [x] Record documentation completion in this checklist

## 16. Development Workflow Smoke Validation
- [x] Define real-project smoke validation scope and pass/fail criteria
- [x] Add an operator-facing smoke validation plan under `docs/plans`
- [x] Record the smoke validation planning completion in this checklist
