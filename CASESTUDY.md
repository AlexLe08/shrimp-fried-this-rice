# Building and Operating a Production Discord Bot: A TypeScript Backend Case Study

**A solo project that grew from "send a reminder message" into a fully tested, CI/CD-deployed backend service — including three real production incidents, how they were diagnosed, and what changed as a result.**

## Overview

I designed and built a backend service in TypeScript that manages scheduled, persistent reminders across multiple client integrations (Discord servers and direct messages), with a full command interface for configuration. The project covers the full lifecycle of a real piece of software: schema design, a scheduling engine, a comprehensive automated test suite, CI/CD with a production deployment gate, and self-managed infrastructure on a Linux server — plus three genuine production incidents that shaped the final design.

**Stack:** TypeScript (native Node.js execution, no build step), discord.js v14, SQLite (`better-sqlite3`), Vitest, GitHub Actions, Ubuntu on Oracle Cloud (systemd-managed).

## Architecture, briefly

- **Persistence layer** (`storage.ts`): a SQLite data-access layer with typed query functions, an upsert pattern for user-scoped settings, and SQL-side due-reminder queries — offloading time-window logic to the database rather than recomputing it in application code on every poll cycle.
- **Scheduler**: a single polling loop (rather than per-reminder timers) that asks the database "what's due right now," processes each reminder independently with isolated error handling so one failure can't block the rest, and includes an overlap guard against a slow tick colliding with the next.
- **Command layer**: a discord.js slash-command framework with per-command cooldowns, hot-reloading of individual command files without a full restart, and a permission-aware creation flow that warns (without blocking) when the bot lacks the access it needs.
- **Deployment**: a self-managed Ubuntu VM, with the whole bot running via Node's native TypeScript execution — no compiled build artifact in the deploy path — managed as a systemd service with graceful shutdown handling on `SIGTERM`.

## Three incidents worth talking about

### 1. A test suite catching a bug that had been silently live in production

While writing tests for the "which reminders are due right now" query, I wrote a deliberate edge-case test: a server that creates reminders but has never touched the "master toggle" setting. The test failed. The query used an inner `JOIN` against a settings table that only gets a row once that toggle is explicitly set — meaning any server that never touched it had its reminders **silently excluded from ever firing**, with no error anywhere. The fix was a `LEFT JOIN` with explicit `NULL` handling, correctly treating "no row" as the schema's stated default. The test that caught it is still in the suite today, specifically guarding against this exact regression.

**Why this matters:** it's a concrete example of a test suite finding a real bug rather than just confirming already-known-good behavior — and it's a good illustration of testing for the *absence* of a common case, not just the happy path.

### 2. Root-causing a duplicate-message bug across two live environments

During local development, commands started producing duplicate replies, occasional `"interaction already acknowledged"` errors, and a status display that only sometimes reflected the latest state. The investigation: two separate processes — my local development instance and the deployed production instance — were both authenticated with the *same* bot credential. Discord dispatches every event to every connected session under that identity, so both processes were independently handling the same commands against two silently diverging local databases.

The fix was architectural, not a patch: provisioning a fully separate application credential for local development, so local and production are genuinely isolated environments rather than sharing an identity. I documented this as a standing rule in the project's setup docs, since it's exactly the kind of subtle, easy-to-reintroduce mistake worth writing down rather than just fixing once.

**Why this matters:** this is a distributed-systems-flavored bug (shared identity, concurrent writers, diverging state) showing up in a small project — good material for a "tell me about a bug that took real investigation" conversation, since the fix required understanding *why* the symptom occurred, not just where the stack trace pointed.

### 3. An unhandled rejection that took the whole service offline

A malformed request caused a command to fail — expected, and handled by a `try`/`catch` that sends the user a fallback error message. But the *fallback reply itself* failed too (a timing race with Discord's interaction token), and that second failure wasn't caught by anything — an unhandled promise rejection that crashed the entire Node process, taking the bot offline across every server it served, not just the one interaction that failed.

The fix: a nested `try`/`catch` around the fallback path itself, so a failure reporting a failure can never again crash the whole service. I wrote a dedicated regression test that reproduces this exact double-failure scenario and asserts the process survives it — directly protecting against a future refactor silently removing that safety net.

**Why this matters:** distinguishes "the bug is fixed" from "the bug can't come back," which is the difference a regression test actually buys you.

## Engineering practices behind the project

- **~96% test coverage** across the codebase (statements/lines), using Vitest with in-memory database isolation for persistence tests and hand-built mock objects (no mocking library) for discord.js interactions — including testing an internal polling scheduler through its real public interface using fake timers, rather than exporting private functions purely to make them testable.
- **CI enforced structurally, not just informationally**: a GitHub branch ruleset blocks merging into `main` unless the full type-check-and-test pipeline passes.
- **CD with a human approval gate**: merging triggers an automated deploy pipeline that SSHs into the production server and restarts the service — but pauses for a manual one-click approval via a GitHub Environment before it touches production, balancing automation against the risk of an unreviewed change reaching real users.
- **Documented incident history**: every significant bug and its root cause is written up in the project's own documentation, not just fixed and forgotten — including a full deployment runbook covering everything from cloud account setup through the CI/CD pipeline, written so it could be followed by someone else or by me in six months.

## What I'd do differently

Given the chance to start over, I'd design the persistence layer's test isolation (in-memory SQLite via an environment variable) from day one rather than adding it after the fact — I initially wrote tests without it and only caught the gap when a test run started producing suspiciously large, unexpected IDs, which turned out to be tests quietly writing into my real local database. It cost a cleanup pass and taught me to treat test isolation as a first-class requirement, not an afterthought bolted on once tests already exist.

## Links

- **Repository:** https://github.com/AlexLe08/shrimp-fried-this-rice
- **Deployment runbook & README:** included in the repository, covering local setup, testing, CI/CD, and full production deployment steps