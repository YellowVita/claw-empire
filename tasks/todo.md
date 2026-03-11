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
