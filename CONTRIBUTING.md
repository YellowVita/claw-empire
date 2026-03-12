# Contributing to Claw-Empire

Thanks for contributing.

## Branch Model

- `main`: release/stable branch (maintainers only, protected)
- `dev`: integration branch for day-to-day PRs (protected)
- `feature/*`, `fix/*`, `docs/*`, `chore/*`: working branches from contributors/forks
- `hotfix/*`: emergency production fixes (maintainers), merged to `main` first, then back-merged to `dev`

## PR Target Rules

- External contributors: open PRs to `dev`
- Maintainer normal work: open PRs to `dev`
- Maintainer emergency hotfix: PR to `main` allowed only for production incidents
- After any hotfix to `main`, back-merge `main -> dev` immediately

## Review and Merge Rules

- Use PR-only merges for both `main` and `dev` (no direct pushes)
- Require at least 1 approval before merge
- Require CI checks to pass before merge
- Prefer `Squash and merge` for a clean history

## Release Flow

1. Feature/fix PRs merge into `dev`
2. When stable, open release PR `dev -> main`
3. After merge to `main`, tag/release as needed
4. Keep `dev` synced with any direct hotfix merged to `main`

## Suggested GitHub Branch Protection

Configure both `main` and `dev`:

- `Require a pull request before merging`
- `Require approvals` (recommended: 1+)
- `Require status checks to pass before merging`
- `Restrict direct pushes`

Recommended required checks:

- `dev` PRs: `ci / fast`
- `main` stability verification: `ci / full`

## Quick Commands

Create a working branch:

```bash
git checkout dev
git pull origin dev
git checkout -b feature/my-change
```

Push and open PR to `dev`:

```bash
git push origin feature/my-change
gh pr create --base dev --fill
```

Recommended PR validation:

```bash
pnpm run ci:fast
```

Full validation before release-sensitive changes:

```bash
pnpm run ci:full
```

Hotfix back-merge (`main -> dev`):

```bash
git checkout dev
git pull origin dev
git merge origin/main
git push origin dev
```
