# 0001: Work the way wol-character-panel does

Status: Accepted · 2026-11-19

## Context

From 2026-08-27 to 09-17 the bot went from the discord.js guide's starter
commands to a deployed reminder bot: SQLite storage, the scheduler, the
status embed, tests (#2, #3), graceful shutdown and a deploy job (#4), and
two fixes to that job (#5, #6). PRs were merged with merge commits; the
first twelve commits, and one more between #3 and #4, went straight to
`main`.
Branches were named `feat/…` and `fix/…` (`fix/ci_v2` with an
underscore). There was no `CLAUDE.md` or other Claude Code setup.

The owner's other project, wol-character-panel, settled a workflow with
Claude Code (its decisions 0005 and 0006): a `CLAUDE.md` with the rules,
each task in its own worktree from `scripts/new-worktree.sh`, a read-only
`reviewer` subagent before each PR, `scripts/check.sh` mirroring CI, small
PRs squash-merged with the PR title as the commit, and no new tooling
without a real bug or friction behind it.

This repository differs in ways that stay: `main` has a ruleset (PR
required, the `test` check required on an up-to-date branch), where
wol-character-panel has none by choice; merging deploys to production
behind the `production` environment's approval, where wol-character-panel
publishes from tags; and there are no releases or semver, so the PR
template's Semver line becomes a Deploys line.

## Decision

Adopt wol-character-panel's workflow here, adapted as above: `CLAUDE.md`,
`.claude/settings.json`, the `reviewer` agent, the worktree, check and
cleanup scripts, `<type>/<kebab-case>` branches, and small PRs
squash-merged with a conventional-commit title.

**Why:** TODO(Alex)

## Consequences

- One commit per PR on `main` from now on; the history before this keeps
  its merge commits.
- The repository still allows merge, squash and rebase merges, both in
  its settings and in the ruleset's allowed merge methods, and doesn't
  delete branches on merge. Until the owner changes both to squash only
  and turns on deleting head branches, squash-merging is by convention.
- `scripts/cleanup-merged.sh` handles both merge commits and squash
  merges, so old and new branches clean up the same way.
- Each merge is a deploy. Small PRs mean small deploys, but also more
  deploy approvals.
- When to revisit: if a second contributor joins, or the bot gets a
  staging environment.
