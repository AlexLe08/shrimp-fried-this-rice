# CLAUDE.md

Project instructions for Claude Code. Personal working-style preferences
live in `CLAUDE.local.md` (gitignored). `README.md` is the reference for
commands, behaviour, setup and deployment, and holds the current status
(Status) and next steps (Roadmap); read it before changing any of those,
and update it in the same PR when they change.

## What this is

A Discord bot (discord.js v14, TypeScript, SQLite through `better-sqlite3`)
that posts periodic reminders to server channels and, for users who opt
in, by DM. It runs 24/7 on an Oracle Cloud "Always Free" VM as the
systemd service `discordbotshrimp`. Commands are registered globally, so
it works in any server it's invited to and in DMs.

It is live: **merging to `main` deploys to production** (see Workflow).

## Decision records

`docs/decisions/` holds one record per decision that shapes the bot or
the workflow, indexed in its `README.md`.

- Before changing an area a record covers, read the record.
- Don't quietly go against one. Propose a new record that supersedes it,
  in the PR that changes course, and say so in the PR.
- Never write a record's **Why**: draft Context and Consequences from the
  history and leave the Why as `TODO(Alex)` for the owner.

## Commands

- Install: `npm ci` (builds `better-sqlite3`'s native module)
- `npm run typecheck`: `tsc --noEmit` over `src/`
- `npm test`: Vitest, `test/**/*.test.ts`, against an in-memory SQLite
  (`test/setup.ts` sets `DB_PATH=':memory:'`); `npm run test:coverage`
  adds coverage (report in `coverage/`); `npm run test:watch` watches
- `npm run dev` / `npm start`: run the bot (`--watch` / once). Both log in
  to Discord with the token in `.env`; ask before running them.
- `npm run deploycommands`: registers every command globally for the
  application in `.env`. Ask before running it.
- `scripts/check.sh`: everything CI's `test` job runs, one line per step,
  full logs in `.logs/`. Done means it passes.
- `scripts/new-worktree.sh <branch>`: the next task's worktree (see
  Workflow); `scripts/setup-worktree.sh` (`npm ci`, and the main
  checkout's `.env`) runs inside it.
- `scripts/cleanup-merged.sh [--apply]`: after a merge, lists (or with
  `--apply` removes) worktrees and local branches whose PR merged.

## Architecture rules

- Node runs the TypeScript in `src/` directly (type stripping, Node 24);
  there is no build in the run or deploy path. So: relative imports name
  the `.ts` file (`./storage.ts`), and only erasable syntax is allowed
  (`erasableSyntaxOnly`: no `enum`, `namespace`, or constructor parameter
  properties). ESM only.
- `src/storage.ts` is the only module that touches SQLite. It opens the
  database on import (`DB_PATH`, else `reminders.db` in the project root),
  creates the tables with `CREATE TABLE IF NOT EXISTS`, and owns the
  limits (`MIN_INTERVAL_MINUTES`, `MAX_INTERVAL_MINUTES`,
  `MAX_REMINDERS_PER_GUILD`). There are no migrations yet: a change to an
  existing table needs a migration plan agreed with the owner first, since
  production's `reminders.db` already has rows. Row interfaces mirror the
  columns by hand; change both in the same commit.
- Commands: one file per command under `src/commands/<category>/`,
  default-exporting `{ data, execute, cooldown? }` (`src/types/command.ts`).
  `index.ts` and `deploy-commands.ts` load every `.ts` file there. A
  changed `data` (name, options, permissions) reaches users only when
  commands are re-registered, which the deploy does. Commands that change
  server settings set `setDefaultMemberPermissions` and
  `setContexts(InteractionContextType.Guild)`. Replies about settings are
  ephemeral (`MessageFlags.Ephemeral`).
- `src/scheduler.ts` polls every 60 s for due reminders (`last_sent_at +
  interval <= now`, in SQL) and sends them one by one. One failed send
  must not stop the batch, crash the process, or retry faster than the
  reminder's own interval when Discord has refused it for good.
- `src/reminderEmbed.ts` builds and refreshes the `/reminder status`
  embed; anything that changes a server's reminders calls
  `refreshGuildStatusMessage` afterwards.
- `src/shutdown.ts` handles SIGTERM/SIGINT (systemd restarts on deploy):
  stop the scheduler, destroy the client, close the database, in that
  order. Nothing may touch the database after it closes.
- Tests are Vitest in `test/`, mirroring `src/`. Discord objects are small
  `vi.fn()` fakes (`test/mocks.ts`, `test/mockInteraction.ts`), cast with
  `as unknown as Client` / `as never`; the scheduler is tested through
  `startScheduler` with fake timers, not by exporting its internals.
  Test-only helpers are exported as `__…ForTests` and never used in `src/`.
- Comments say why, not what: the reason, the constraint, the incident
  behind a choice. Don't add comments that explain the language or the
  discord.js API, or commented-out code. Older code still has both; clean
  them up in their own PR, not in passing.

## Hard constraints

- Never run anything against the production bot. Local `.env` holds the
  separate local-dev application's token; two processes on one token
  double every reminder (README's warning). Don't `ssh` to the VM or
  restart the service: production changes only through a merged PR.
- Free tiers only (Oracle Cloud Always Free, GitHub Actions). Never
  configure or suggest anything that needs a payment method.
- CI's job id is `test` (`.github/workflows/ci.yml`); the `main` ruleset
  requires that check by name, so don't rename it. Don't add `paths:`
  filters to its triggers.
- Node 24 (`.nvmrc`, `engines`), like the VM and CI.
- Adding a runtime dependency is a design decision for the owner, not an
  implementation detail.

## Workflow

- `main` has a ruleset: changes go through a PR, the `test` check must
  pass on a branch that is up to date with `main`, and force pushes and
  deletion are blocked. Branch off `main`, PR, CI green, owner merges.
  Never push to `main`. Keep PRs small, one change each; a large change
  is a series of them, each passing the checks. When one PR needs
  another that hasn't merged, base it on that branch and say so; GitHub
  retargets it to `main` when the first merges.
- Merging deploys: the `deploy` job runs after `test` on every push to
  `main`, waits for the owner's approval (the `production` environment),
  then on the VM resets to `origin/main`, runs `npm install`, restarts the
  service and re-registers commands. Write each PR's Deploys line with
  that in mind.
- Branches are `<type>/<what-in-kebab-case>`, the type matching the PR
  title's: `feat`, `fix`, `docs`, `test`, `ci`, `refactor`, `chore`,
  `deps`. PRs are squash-merged
  ([decision 0001](docs/decisions/0001-workflow-from-wol-character-panel.md)):
  the PR title and body become the one commit on `main`, so write the
  title like a commit subject (`fix: …`, `docs: …`).
- New tooling (dependencies, workflows, scripts, agents, skills, checks)
  only for a real bug or real friction, named in the PR; feature work
  comes first. Maintaining what exists isn't new tooling.
- Each task starts in a new worktree under `.claude/worktrees/`
  (gitignored): `scripts/new-worktree.sh <branch>` branches from the latest
  `origin/main` with no upstream, into `.claude/worktrees/<branch, / as ->`,
  and runs `scripts/setup-worktree.sh` there; then switch the session into
  it. With no upstream, a bare `git push` can't hit `main`; push with
  `git push -u origin <branch>`.
- Once the PR has merged and its remote branch is deleted, run
  `scripts/cleanup-merged.sh` (a dry run), then `--apply`. It removes only
  worktrees and local branches whose remote branch is gone and which are
  merged (an ancestor of `origin/main`, or for a squash merge, no further
  than the head of a PR merged into `main`, asked of GitHub with `gh`). A
  dirty worktree is refused. It skips the worktree it is called from.
- Scratch files (probe scripts, logs) go in the worktree's `.logs/`
  (gitignored).
- Tests: never delete, skip, or loosen a test, or change its expected
  values, to make a check pass. If a test looks wrong, stop and report
  why. New behaviour gets new tests. Deleting code deletes its tests;
  say so in the PR.
- Stay inside the task: no drive-by refactors, renames, or new
  dependencies; list what you noticed instead.
- Commit in small logical steps; Claude may commit and push its task
  branch (never `--force`). The `reviewer` subagent (`.claude/agents/`)
  reviews the branch before the PR is opened; only the owner approves,
  merges, and approves deploys.
- A change users can see updates the README's Status, Commands or
  Roadmap in its own PR, not in a follow-up.
