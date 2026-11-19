# 0002: Schema migrations with SQLite's user_version

Status: Accepted · 2026-11-19

## Context

`src/storage.ts` created its four tables with `CREATE TABLE IF NOT EXISTS`
on every start, and had no way to change one: that statement never alters
a table that already exists. CLAUDE.md required a migration plan agreed
with the owner before any change to an existing table, because
production's `reminders.db` on the VM already has rows, and the deploy
(`.github/workflows/ci.yml`) only resets the code and restarts the
service: nothing runs against the database on its own.

Snoozing reminders (the Roadmap's "Snooze/pause command") was the first
feature to need a new column: `snoozed_until` on `guild_reminders` and
`user_settings`. The options were:

- a migration step in `storage.ts`, versioned by SQLite's built-in
  `PRAGMA user_version` (an integer in the database header, 0 on any
  database that has never set it);
- checking `PRAGMA table_info` for each column before adding it, with no
  version;
- a migration library, which would be a new runtime dependency;
- a separate table for snoozes, which avoids altering a table but splits a
  reminder's state across two tables.

The owner approved the first in the PR that adds snoozing.

## Decision

`storage.ts` keeps the original `CREATE TABLE IF NOT EXISTS` statements
unchanged, then applies an append-only list of migrations: migration *n*
takes `user_version` from *n* to *n* + 1, all pending ones in a single
transaction on startup. Migration 0 adds `snoozed_until INTEGER NOT NULL
DEFAULT 0` to `guild_reminders` and `user_settings`. There are no down
migrations.

**Why:**

Necessary to edit existing tables when we previously had no methods to do so. 

## Consequences

- A new database and production's go through the same steps, so tests on
  an in-memory database exercise the same schema production ends up with;
  `test/storage/migrations.test.ts` also opens a database built the way
  production's was before migrations, with rows in it.
- Migrations run when the bot starts, which on the VM is the deploy's
  `systemctl restart`. A migration that fails rolls back with its
  transaction and the bot exits; the deploy's login check then fails the
  job, and the database is as it was before. `Restart=on-failure` keeps
  restarting the bot every 5 seconds, failing the same way, so no
  reminders send until a fix is deployed.
- A migration, once merged, must never be edited or reordered: production
  has already run it. A fix is a new migration.
- Without down migrations, rolling back means reverting the code and
  leaving the schema ahead. That only works while migrations are additive
  (a new column with a default, a new table), since queries use
  `SELECT *` into hand-written interfaces and ignore extra columns. A
  migration that renames, drops or retypes a column needs its own plan,
  and a backup of `reminders.db` first.
- `user_version` is one integer per database file; nothing else in the
  project may use it.
