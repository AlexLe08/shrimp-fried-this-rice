# Building and Operating a Discord Bot in Production: A TypeScript Backend Case Study

**A solo project that grew from "send a reminder message" into a tested, CI/CD-deployed service running 24/7: the incidents it hit, how each was diagnosed, and what changed because of them.**

## Overview

I designed and built a TypeScript service that sends scheduled, persistent reminders to Discord server channels and, for users who opt in, by DM, with a slash-command interface for configuring them. It has since grown into features for an FF14 Free Company's server, starting with follow-ups on trial members for its moderators. It covers the whole lifecycle of a real piece of software: schema design and migrations, a scheduling engine that has to survive failed sends and restarts, an automated test suite, CI/CD with an approval gate, and a self-managed Linux server. The design was shaped by real incidents along the way.

**Stack:** TypeScript run directly by Node 24 (type stripping, no build step), discord.js v14, SQLite (`better-sqlite3`), Vitest, ESLint and Prettier, GitHub Actions, Ubuntu on an Oracle Cloud "Always Free" VM under systemd.

## Architecture, briefly

- **Persistence** (`core/database.ts` and `reminders/storage.ts`): `core/database.ts` is the only module that opens SQLite and owns the schema, and each feature area's storage module holds its own queries. Typed query functions, upserts for per-user settings, and due-reminder queries done in SQL (`last_sent_at + interval <= now`), so the database answers "what's due" instead of the app recomputing it on every poll. Schema changes are versioned migrations, tracked with SQLite's `PRAGMA user_version` and applied in one transaction on startup, so a deploy's restart migrates the production database.
- **Scheduler** (`core/scheduler.ts`, running `reminders/dueReminders.ts`'s checks): one polling loop rather than a timer per reminder. Every 60 s it asks the database what's due and sends each reminder independently, so one failure can't block the rest. A guard skips a tick while the previous one is still running.
- **Commands**: `/reminder` (create, edit, list, status, toggle, snooze, unsnooze, delete, master) and `/remindme`, with label autocomplete, per-user cooldowns, and permission-aware replies that warn but still save when the bot can't yet post where it's been asked to.
- **Messages** (`reminderMessage.ts`): reminders go out as embeds by default, with the edge cases Discord's behaviour forces (below).
- **Deployment**: the bot runs as a systemd service. Shutdown on `SIGTERM` stops the scheduler, waits for any send under way, destroys the Discord client and closes the database, in that order.

## Incidents and what they changed

### 1. A test caught a bug that had been silently live in production

While writing tests for the "which reminders are due" query, I added an edge case: a server that creates reminders but has never touched the server-wide on/off switch. The test failed. The query used an inner `JOIN` against a settings table that only gets a row once that switch is set, so any server that never touched it had its reminders **silently excluded from ever sending**, with no error anywhere. The fix was a `LEFT JOIN` that treats "no row" as the schema's default, "enabled". The test is still in the suite as a regression guard.

**Why it matters:** the suite found a real bug instead of confirming behaviour already known to work, by testing for the absence of a row, not just the happy path.

### 2. Duplicate replies from two processes sharing one identity

During local development, commands started producing duplicate replies, occasional `"Interaction has already been acknowledged"` errors, and a status embed that only sometimes reflected the latest state. The cause: my local instance and the production instance were both logged in with the *same* bot token. Discord delivers every event to every session using that token, so both processes were handling the same commands against two separate databases that were drifting apart.

The fix was to separate the environments rather than patch the symptom: a second Discord application with its own token, used only for local development. It's now a standing warning in the README and the deployment runbook, because it's an easy mistake to make again.

**Why it matters:** a distributed-systems bug (shared identity, concurrent writers, diverging state) in a small project. The fix needed an understanding of *why* the symptom occurred, not just where the stack trace pointed.

### 3. A failure while reporting a failure took the service offline

A malformed request made a command fail. That was expected, and a `try`/`catch` sent the user a fallback error message. But the fallback reply failed too (a race with Discord's interaction token), nothing caught that second failure, and the unhandled promise rejection crashed the Node process, taking the bot offline in every server, not just for the one interaction.

The fix was a `try`/`catch` around the fallback itself, plus a regression test that reproduces the double failure and asserts the process survives. Later, adding type-aware lint rules (`no-floating-promises`, `no-misused-promises`) found two more paths to the same kind of crash: event-handler promises handed to an emitter that ignores them, and an unhandled rejection from the login call. Both now log instead of crashing, and a failed login exits with a nonzero code so systemd restarts the bot.

**Why it matters:** it's the difference between "the bug is fixed" and "this class of bug can't come back", first through a regression test, then through a lint rule that checks every promise.

### 4. Failed sends that retried every minute, forever

A reminder whose send failed kept its old `last_sent_at`, so it was due again on the next poll. A deleted channel, a channel the bot couldn't post in, or a user with DMs closed meant a failed API call and an error log every 60 seconds, indefinitely.

The scheduler now sorts failures by cause. A channel that's gone disables the reminder, and the status embed shows it as disabled. A send Discord refuses for good (missing permissions, DMs closed) is recorded as an attempt, so it's retried only after the reminder's own interval; granting the permission later lets it start sending again. Network errors and Discord server errors are retried on the next poll, as before.

**Why it matters:** retry policy depends on the error. Treating every failure the same either hammers the API or gives up on errors that would have recovered.

### 5. Every deploy could repeat a reminder

Stopping the scheduler only cleared its timer, so a batch already running kept going while shutdown destroyed the client and closed the database. A send that completed then failed to record that it had been sent, and the reminder went out again after the restart. Every deploy restarts the bot, so this could happen on every deploy.

Stopping the scheduler is now asynchronous: it lets each running batch finish its current send, skips the rest, and resolves when they're done. Shutdown waits for it before destroying the client and closing the database.

**Why it matters:** graceful shutdown means ordering, not just catching the signal. Nothing may touch the database after it closes, and nothing should be cut off between sending and recording the send.

### 6. A deploy that reported success for a bot that never logged in

The deploy job treated a restarted service as a working bot. But `systemctl restart` returns as soon as the process starts, so a bot that then failed to log in (a bad token, Discord down) still passed. The job now records the restart time and polls the service's journal for the bot's `Ready! Logged in as` line, failing the deploy if it hasn't appeared within 60 seconds. Command registration also now exits nonzero on failure, and the VM installs with `npm ci`, so production runs exactly the dependency tree CI tested.

**Why it matters:** a deploy check should test the outcome you care about (the bot is online), not a proxy for it (the process started).

### 7. Checking Discord's behaviour instead of assuming it

Moving reminders to embeds raised questions the documentation didn't settle, so I tested them against a development server and read the results back through the API. A mention inside an embed doesn't notify anyone. A link isn't previewed when the bot's message carries its own embed. And Discord rejects a bot's embed outright in a channel where it lacks the Embed Links permission (error 50013).

That last finding would have been a silent outage: the scheduler counts 50013 as a permanent refusal, so such a reminder would never send. The final design repeats a reminder's mentions as text above the embed, sends messages with links as plain text to keep their previews, falls back to plain text where Embed Links is missing, and warns the admin about it when the reminder is created.

**Why it matters:** a fast-moving third-party API is a dependency like any other. Checking its real behaviour before building on it turned a would-be outage into a warning.

## Engineering practices

- **Tests:** ~98% of statements and ~99% of lines, with Vitest against an in-memory SQLite database and small hand-built fakes for discord.js objects (no mocking library). The scheduler is tested through its public interface with fake timers rather than by exporting its internals.
- **CI as a gate:** a GitHub ruleset blocks merging into `main` unless lint, formatting, type-checking and the full test suite pass on a branch that's up to date with `main`.
- **CD with a human checkpoint:** merging triggers a deploy job that waits for one-click approval through a GitHub Environment, then SSHes into the VM, resets it to `origin/main`, installs, restarts the service, re-registers commands and waits for the bot to log in. The SSH key and host are repository secrets; nothing about the VM is in the code.
- **Schema migrations:** versioned with SQLite's `user_version`, run in one transaction at startup. The first one added a column that production's database took on its next deploy.
- **Written decisions:** decision records (`docs/decisions/`) capture the choices that shape the bot and the workflow. The roadmap (`docs/roadmap.md`) records what was done, what's next, and the incidents behind each change.
- **Workflow:** since November 2026 the work has gone through Claude Code under a fixed process: a git worktree per task, small squash-merged pull requests, a review pass before each PR opens, and only me approving merges and deploys. `CLAUDE.md` holds the rules it works under.
- **Free tier only:** the whole thing runs on Oracle Cloud's Always Free tier and GitHub Actions' free minutes.

## What I'd do differently

I'd set up test isolation (in-memory SQLite through an environment variable) from day one rather than adding it later. I first wrote tests without it, and only caught the gap when a test run produced suspiciously large IDs: the tests had been writing into my real local database. It cost a cleanup pass and taught me to treat isolation as a requirement from the first test, not something to add once tests exist.

## Links

- **Repository:** https://github.com/AlexLe08/shrimp-fried-this-rice
- **README:** features, commands, local setup, testing and deployment
- **Deployment runbook:** [`ORACLE_CLOUD_DEPLOYMENT.md`](ORACLE_CLOUD_DEPLOYMENT.md), from cloud account setup through the CI/CD pipeline
