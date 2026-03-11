# Symphony Workflow Adoption Plan for Claw-Empire

## Goal

Decide whether the current Claw-Empire workflow is already the best fit for this project, and identify only the Symphony ideas that improve the `development` workflow without breaking Claw-Empire's core product model.

This document is intentionally selective. It is not a proposal to turn Claw-Empire into Symphony.

## Short Answer

The current workflow should not be replaced wholesale.

Claw-Empire and Symphony optimize for different things:

- Claw-Empire optimizes for company-style orchestration: tasks, departments, team leaders, meetings, review gates, and inbox-based control.
- Symphony optimizes for unattended ticket execution: issue polling, per-issue workspaces, workflow-as-code, PR feedback loops, and clean handoff states.

The right move is to keep Claw-Empire's orchestration model and import a small number of Symphony ideas that add rigor to the `development` pack.

## Current Assessment

### What Claw-Empire does well already

- Strong multi-agent orchestration model with department and leader concepts.
- Explicit meeting and review mechanics.
- Workflow Pack abstraction already exists and is flexible enough to carry domain-specific behavior.
- Project-level overrides already exist via `.claw-workflow.json`.
- Task execution hooks already exist at global and project scope.

### Where the current workflow is weaker than it could be

- Development workflow policy is split across DB settings, route logic, orchestration logic, and project JSON overrides.
- There is no single project-owned workflow contract as clear as Symphony's `WORKFLOW.md`.
- Development tasks do not have one obvious source-of-truth artifact equivalent to Symphony's workpad comment.
- PR/review feedback handling is less explicit than Symphony's required sweep model.
- The state model for development delivery is present, but not expressed as a compact, obvious contract for repository owners.

## What To Borrow From Symphony

### 1. Repository-owned workflow contract

Adopt the idea that each project can define its own workflow behavior in version control.

Recommended adaptation:

- Keep `.claw-workflow.json` for backward compatibility.
- Introduce a richer project workflow file for development projects, such as:
  - `WORKFLOW.md`, or
  - `.claw-workflow.yaml`
- Treat this file as the primary development workflow contract for project-specific behavior.

This contract should cover:

- default development workflow mode
- required validation commands
- review expectations
- PR handoff policy
- worktree/workspace lifecycle hooks
- optional task reporting template

This is the highest-value Symphony idea to adopt because it reduces hidden policy.

### 2. A single execution source of truth

Symphony's workpad concept is worth importing in spirit.

Recommended adaptation:

- For `development` tasks, maintain one canonical execution artifact per task.
- That artifact can be stored as:
  - a structured task note,
  - a task-scoped markdown artifact,
  - or a normalized task log summary generated from existing logs.

It should always contain:

- current plan
- reproduction evidence
- validation evidence
- review feedback checklist
- final handoff summary

This should not replace task logs or meeting minutes. It should summarize them.

### 3. Required PR feedback sweep for development tasks

Symphony is stricter than Claw-Empire here, and that strictness is useful.

Recommended adaptation:

- In the `development` workflow, block promotion to final review until:
  - open PR review comments are checked,
  - inline comments are checked,
  - required validation is rerun after fixes,
  - unresolved actionable comments are either fixed or explicitly answered.

This should be a development-pack rule, not a global workflow rule.

### 4. Explicit development handoff states

Symphony's state transitions are easier to reason about for software delivery.

Recommended adaptation:

- Preserve Claw-Empire's broader task lifecycle.
- Add a development-pack-facing handoff model on top:
  - `Queued`
  - `In Progress`
  - `Review Ready`
  - `Human Review`
  - `Merging`
  - `Done`
  - `Rework`

This can be implemented as workflow metadata, not necessarily as a replacement for global task statuses.

### 5. Last-known-good workflow loading

Symphony's workflow reload behavior is operationally sound.

Recommended adaptation:

- When project workflow config fails to parse, keep the last valid effective config for runtime use.
- Surface warnings clearly in logs and settings UI.
- Do not let one malformed project workflow file fully degrade task execution when a valid previous config exists.

This is especially useful if Claw-Empire gains a richer project workflow file.

## What Not To Borrow

### 1. Linear-first architecture

Do not reshape Claw-Empire around Linear tickets.

Reason:

- Claw-Empire is not a Linear wrapper.
- Its control plane is broader: inbox, task board, departments, directives, project mapping, and internal orchestration.

### 2. Fully unattended philosophy as the default

Do not adopt Symphony's "never ask a human unless truly blocked" posture globally.

Reason:

- Claw-Empire intentionally includes review, approval, and meeting structures.
- Human checkpoints are part of the product, not just an implementation inconvenience.

### 3. Replacing company-style orchestration with a thin issue runner

Do not collapse meetings, department routing, and leader logic into a simpler ticket loop.

Reason:

- That would remove one of Claw-Empire's defining product characteristics.
- It would make other non-development packs worse, not better.

### 4. Single workflow model for every pack

Do not force all packs to behave like software delivery tickets.

Reason:

- `novel`, `roleplay`, `report`, and `video_preprod` have different success criteria.
- Symphony's strongest ideas map mainly to the `development` pack.

## Recommended Product Direction

### Direction

Keep the current Claw-Empire orchestration engine.

Tighten only the `development` workflow using Symphony-inspired rigor.

### Principle

Import structure, not identity.

In practice:

- borrow Symphony's workflow contract discipline
- borrow Symphony's review rigor
- borrow Symphony's handoff clarity
- keep Claw-Empire's departments, meetings, and pack model

## Proposed Implementation Phases

### Phase 1. Development workflow contract

Add a richer project-owned workflow file and loader.

Possible scope:

- support `WORKFLOW.md` or `.claw-workflow.yaml`
- keep `.claw-workflow.json` as fallback
- merge effective config from:
  - project workflow file
  - DB defaults
  - pack defaults

Suggested touchpoints:

- `server/modules/workflow/packs/project-config.ts`
- `server/modules/workflow/packs/effective-pack.ts`
- `server/modules/workflow/orchestration/task-execution-policy.ts`

### Phase 2. Canonical development run sheet

Create one normalized task-level development execution summary.

Possible scope:

- add a stored markdown/json summary artifact
- generate/update after reproduction, implementation, validation, and review milestones
- expose it in UI as the primary task execution brief

Suggested touchpoints:

- `server/modules/workflow/orchestration/task-quality-evidence.ts`
- `server/modules/workflow/orchestration/run-complete-handler.ts`
- task detail UI components

### Phase 3. PR feedback gate

Add a development-only review gate for PR comment resolution.

Possible scope:

- collect unresolved PR feedback
- block final review promotion while actionable feedback remains
- store a checklist summary in the canonical run sheet

Suggested touchpoints:

- review/finalize orchestration modules
- GitHub integration layer
- task report UI

### Phase 4. Development handoff metadata

Expose clearer delivery sub-states without replacing the existing global status model.

Possible scope:

- store `workflow_meta_json` substate for development tasks
- render the substate in task UI and reports
- use it for clearer automation and QA gates

## Implementation Status

The core adoption roadmap has now been completed.

Completed:

- Phase 1. Development workflow contract
- Phase 2. Canonical development run sheet
- Phase 3. PR feedback gate
- Phase 4. Development handoff metadata

This means the original Symphony-inspired adoption scope for the `development` pack is finished.
What remains is no longer "feature adoption" so much as operational hardening and product polish.

## Post-Phase Priorities

### Priority 1. PR gate tuning

The current PR feedback gate is intentionally conservative.

Recommended next step:

- decide whether optional or non-blocking checks need allowlist/ignore behavior
- reduce false-positive blocking without weakening the required feedback sweep

This is the highest-value follow-up because it directly affects day-to-day developer friction.

### Priority 2. Last-known-good workflow config loading

The workflow contract loader currently falls back on parse failure, but it does not yet preserve a last valid runtime config snapshot.

Recommended next step:

- retain the last valid effective project workflow config
- keep execution stable when `WORKFLOW.md` is temporarily malformed
- surface parse warnings clearly in logs and UI

This is the main remaining Symphony idea with strong operational value.

### Priority 3. Development workflow QA and telemetry

Now that the full `development` workflow stack exists, it should be validated as a system rather than only as isolated features.

Recommended next step:

- build a small regression/QA checklist using real development tasks
- inspect handoff transitions, run sheet generation, and PR gate outcomes together
- identify noisy gate conditions and weak UX points from real usage

### Priority 4. UI surface expansion

Handoff metadata and run sheet summaries are currently exposed only where they add the most value with minimal risk.

Recommended next step:

- decide whether project-level history and insight views should expose the same development delivery signals
- only expand surfaces if the metadata proves useful in actual operator workflows

### Priority 5. Release and architecture documentation

The implementation is in place, but the public/internal documentation should eventually reflect the new development workflow model as one coherent system.

Recommended next step:

- add release notes summarizing the Phase 1-4 rollout
- refresh architecture docs so `WORKFLOW.md`, run sheets, PR gate, and handoff metadata are described together

## Decision Matrix

### Completed now

- project-owned workflow contract
- canonical execution summary artifact
- PR feedback sweep gate
- development-specific substate model

### Adopt later if needed

- last-known-good workflow reload behavior
- PR gate optional-check tuning
- broader UI exposure of development delivery metadata

### Do not adopt

- Linear-centric architecture
- full Symphony operating model
- global unattended execution policy
- replacing company-style meetings with a flat ticket runner

## Final Recommendation

The current Claw-Empire workflow is good enough to keep, but not good enough to freeze.

The best next step is not a rewrite. It is a targeted hardening of the `development` pack using Symphony's best ideas:

- workflow-as-code
- stronger development review gates
- one canonical execution record
- clearer handoff state semantics

That adoption work is now complete.

The next best step is operational hardening:

- tune the PR gate to reduce avoidable blocking
- add last-known-good workflow config behavior
- validate the full development workflow with real-world QA passes
