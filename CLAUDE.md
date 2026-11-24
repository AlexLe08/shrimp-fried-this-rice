# CLAUDE.md

Project instructions for Claude Code. Personal working-style preferences
live in `CLAUDE.local.md` (gitignored). Current status and next steps
live in `docs/roadmap.md`: read it when starting a task. `README.md` is
the reference for features, commands, behaviour, setup and deployment;
read it before changing any of those, and update it in the same PR when
they change.

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

- Install: `npm ci` (`better-sqlite3` 13 ships prebuilt binaries, so it
  compiles only on a platform without one)
- `npm run lint`: ESLint with typescript-eslint's recommended rules, and
  `no-floating-promises`/`no-misused-promises` (type-aware) on `src/`
- `npm run format` / `npm run format:check`: Prettier (tabs, single quotes,
  120 columns; JSON at 2 spaces; Markdown not formatted)
- `npm run typecheck`: `tsc --noEmit` over `src/`, then `tsc -p test` over
  `test/` with the same options (`test/tsconfig.json`), as Vitest strips
  types without checking them
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
- `src/core/database.ts` is the only module that opens SQLite and owns
  the schema ([decision 0004](docs/decisions/0004-feature-storage-modules.md)).
  It opens the database on import (`DB_PATH`, else `bot.db` in the
  project root, from `databasePath()`, pinned by a test), creates the
  tables with `CREATE TABLE IF NOT EXISTS`, applies pending `MIGRATIONS`
  (one list for every area, versioned by `PRAGMA user_version`, one
  transaction, on startup;
  [decision 0002](docs/decisions/0002-schema-migrations-with-user-version.md)),
  and exports the handle, `closeDatabase` and `__resetForTests` (which
  clears every table, so a new table is added there too). Each area's
  `storage.ts` (`src/reminders/storage.ts`; one per feature in an area
  with several, such as `src/ffxiv/recruit/storage.ts`) is the only code
  that queries its tables, and owns their row interfaces and limits
  (`MIN_INTERVAL_MINUTES`, `MAX_INTERVAL_MINUTES`,
  `MAX_REMINDERS_PER_GUILD`). A schema change is a new migration appended
  to the list, never an edit to a `CREATE TABLE` or to a merged migration,
  since production's `bot.db` has run them. One that isn't additive
  (renames, drops, retypes a column) needs a plan agreed with the owner
  first. While the bot is pre-release (README's Status says so), that
  plan may be a reset instead: rewrite the `CREATE TABLE`s in
  `core/database.ts`, empty `MIGRATIONS`, and the PR's Deploys line asks
  the owner to delete production's `bot.db` before approving
  ([decision 0003](docs/decisions/0003-pre-release-schema-resets.md)).
  Row interfaces mirror the columns by hand; change both in the same
  commit.
- `src/` is grouped by area: `core/` (bot plumbing and Discord helpers
  any area may use), `reminders/` and `ffxiv/` (later `minecraft/`),
  each holding its own commands, events, embeds and `storage.ts`.
  `dashboard/` holds the web dashboard, served on `127.0.0.1` behind
  `cloudflared` (decisions 0008 and 0009).
  `src/index.ts` and `src/deploy-commands.ts` stay at the top of `src/`:
  the VM's systemd unit starts `./src/index.ts`, so moving it would leave
  the bot down after the deploy.
- `src/reminders/snooze.ts` holds what `/reminder snooze` and `/remindme`
  share: the duration and after-snooze choices, and how a snooze is
  described. `src/reminders/options.ts` holds the option builders
  `/reminder` and `/remindme` share (`interval`, `message`, `embed`) and
  `/reminder`'s `label`.
- `/reminder`'s subcommands are one file each in
  `src/reminders/subcommands/`, default-exporting
  `{ name, build, execute }` (`ReminderSubcommand` in its `helpers.ts`).
  `reminder.ts` registers them from its `SUBCOMMANDS` list, in that order,
  and routes to them by name; a test fails if a file there is missing from
  the list.
- Commands: one file per command under `src/<area>/commands/`,
  default-exporting `{ data, execute, cooldown? }`
  (`src/core/types/command.ts`). `src/core/loadCommands.ts` loads every
  `.ts` file there, for both `index.ts` and `deploy-commands.ts`, and
  `index.ts` loads every `.ts` file in `src/<area>/events/`, each
  default-exporting an `Event` (`src/core/types/event.ts`, written
  `satisfies Event<Events.X>` so `tsc` checks the handler's arguments);
  anything else (helpers, subcommand handlers) goes outside those two
  folders. A
  changed `data` (name, options, permissions) reaches users only when
  commands are re-registered, which the deploy does. Commands that change
  server settings set `setDefaultMemberPermissions` and
  `setContexts(InteractionContextType.Guild)`. Replies about settings are
  ephemeral (`MessageFlags.Ephemeral`).
- `src/core/scheduler.ts` runs a list of named checks (`ScheduledCheck`:
  `{ name, run(signal) }`) every 60 s, skipping one still running from the
  last poll, logging one that throws, and aborting their signal on
  `stopScheduler`, which waits for them. `ready.ts` passes the list; an
  area adds a check to it (`dueReminderChecks(client)` from
  `src/reminders/dueReminders.ts`), closing over the client it needs. The
  reminder checks ask for due reminders (`last_sent_at + interval <= now`,
  in SQL) and send them one by one. One failed send must not stop the
  batch, crash the process, or retry faster than the reminder's own
  interval when Discord has refused it for good.
- `src/reminders/statusEmbed.ts` builds, replaces and refreshes the
  `/reminder status` embed; anything that changes a server's reminders
  calls `refreshGuildStatusMessage` afterwards.
- `src/core/shutdown.ts` handles SIGTERM/SIGINT (systemd restarts on
  deploy): stop the dashboard's server (`src/dashboard/server.ts`,
  finishing requests under way, for up to 2 s), stop the scheduler,
  destroy the client, close the database, in that order. Nothing may touch the database after
  it closes.
- Tests are Vitest in `test/`, mirroring `src/`. Discord objects are small
  fakes built from `vi.fn()`s (`test/mocks.ts`, `test/mockInteraction.ts`), cast with
  `as unknown as Client` / `as never`, except where a function takes a
  narrow interface of what it uses (`SchedulerClient`,
  `StatusMessageClient`, `EmojiClient`), which the fakes fit; the scheduler and its checks are
  tested through `startScheduler` with fake timers, not by exporting their
  internals.
  Test-only helpers are exported as `__…ForTests` and never used in `src/`.
- Comments say why, not what: the reason, the constraint, the incident
  behind a choice. Don't add comments that explain the language or the
  discord.js API, or commented-out code.

## Hard constraints

- Never run anything against the production bot. Local `.env` holds the
  separate local-dev application's token; two processes on one token
  double every reminder (README's warning). Don't `ssh` to the VM or
  restart the service: production changes only through a merged PR.
- Free tiers only (Oracle Cloud Always Free, GitHub Actions). Never
  configure or suggest anything that needs a payment method. The one
  exception is registering and renewing the owner's domain,
  `alexle.dev`, at Porkbun
  ([decision 0008](docs/decisions/0008-dashboard-hostname-and-https.md)).
- CI's job id is `test` (`.github/workflows/ci.yml`); the `main` ruleset
  requires that check by name, so don't rename it. Don't add `paths:`
  filters to its triggers.
- Node 24 (`.nvmrc`, `engines`), like the VM and CI.
- TypeScript stays on `~6.0` until typescript-eslint supports 6.1 and up
  (8.x stops below 6.1); wol-character-panel is on 6.0 for the same reason.
- Adding a runtime dependency is a design decision for the owner, not an
  implementation detail. The owner chose `hono` and `@hono/node-server`
  for the dashboard on 2026-11-23
  ([decision 0009](docs/decisions/0009-dashboard-on-hono.md)), and
  `age-encryption` for encrypting the off-VM copies of `bot.db` on
  2026-11-24 ([decision 0011](docs/decisions/0011-off-vm-backups.md)).

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
  then on the VM resets to `origin/main`, runs `npm ci`, restarts the
  service, re-registers commands and waits until 60 s after the restart
  for the bot to log in (the `Ready! Logged in as` line); the job fails if
  either step did. Write each PR's Deploys line with
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
- A change users can see updates the README's Features, Commands or
  Design notes in its own PR, not in a follow-up.
- The roadmap's Done entry goes in the feature's own PR, which also moves
  or removes its Next up or Later item (no follow-up commits after
  merging).
