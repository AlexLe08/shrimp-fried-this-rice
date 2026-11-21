# 0004: One module owns the database; each area's storage module queries it

Status: Accepted · 2026-11-20

## Context

Until this record, `src/storage.ts` was the only module that touched
SQLite: it opened the database, created the tables, ran the migrations
([decision 0002](0002-schema-migrations-with-user-version.md)), and held
every query, row interface and limit. That was all reminder code, about
370 lines.

The feature plan ([`../plans/minecraft-ff14-features.md`](../plans/minecraft-ff14-features.md))
adds tables for trial members (`/recruit`), collections, Lodestone news
and role check-ins. Put in the one file, `storage.ts` would hold the
queries of every area. The plan's "Feature storage modules" proposed a
module per feature sharing one database handle, and on 2026-11-20 the
owner revised it into this shape and moved this record forward from the
plan's E1 to the refactor's task 3 ([`../plans/refactor.md`](../plans/refactor.md)),
so the features start from it. The refactor's task 2 (#32) had already
grouped `src/` into area folders (`core/`, `reminders/`, later `ffxiv/`
and `minecraft/`).

Constraints that shaped it:

- `PRAGMA user_version` is a single number per database, so there is one
  migration sequence, not one per area.
- Production has a `reminders.db` in the project root that the bot opens
  by a default path built from the opening module's own folder. Moving
  that module without changing the path would silently open a new, empty
  database (refactor task 3).
- The tests reset the database between cases through `__resetForTests`,
  which has to know every table.

## Decision

`src/core/database.ts` is the one module that opens SQLite and owns the
schema: the handle (`db`), every `CREATE TABLE`, the one `MIGRATIONS`
list, `closeDatabase` and `__resetForTests`. Each area has its own
storage module (`src/reminders/storage.ts` first), or one per feature in
an area that holds several (`src/ffxiv/recruit/storage.ts`), the only
code that queries that area's tables; it imports `db` and keeps its
queries, row interfaces and limits. Every area shares the one database
file, renamed from `reminders.db` to `bot.db` now that it holds more than
reminders.

In frontend terms: `core/database.ts` is like the module that creates
the app's single API client and exports it. It sets up the connection and
the schema, and then stays out of the way: queries don't pass through it.
Each area's `storage.ts` is like a feature's data layer (its hooks or
service file), which uses that shared client for its own endpoints, here
its own tables.

**Why:**

This bot is scaling up to be more than just reminders, so while it's still in a pre-release state, I've decided to start considering features as modules and having a core for functions that features can stem from. This should allow it to be more intuitively read by humans looking for the logic of each feature when digging through the code without having to dig through the core files that may not be relevant. Scale is still fairly small so one db file should remain enough until a case occurs where we may need more than one db.

## Consequences

- A feature's queries and limits live in its own folder, beside its
  commands and checks; `src/reminders/storage.ts` doesn't grow with
  features that aren't reminders.
- A schema change still touches `core/database.ts` (a migration appended
  to the shared list) as well as the area's storage module (its
  queries and row interfaces). Two areas' PRs that each add a migration
  conflict on that list; the second to merge rebases and takes the next
  number.
- Any area could import `db` and query another area's tables. Nothing in
  the code stops it; the rule is that an area queries its own tables, and
  reads another area's data through that area's storage module.
- `__resetForTests` in `core/database.ts` clears every table, so a new
  table is added there too.
- A pre-release reset ([decision 0003](0003-pre-release-schema-resets.md))
  now rewrites the `CREATE TABLE`s in `core/database.ts`. Decisions 0002
  and 0003 name `storage.ts` because that's where the schema was when they
  were made.
- The default database path is `bot.db`, resolved from the project root
  and pinned by `test/core/database/databasePath.test.ts`, so moving
  `database.ts` can't silently point it somewhere else.
- The rename reset production, as a decision 0003 reset does: the deploy
  opened a new, empty `bot.db`, and the test reminders in `reminders.db`
  were left behind, with the owner's agreement (pre-release, no users).
  The old `reminders.db` and its `-wal`/`-shm` files stay on the VM until
  deleted by hand.
- Worth revisiting if an area needs a database of its own (for example a
  large cache that shouldn't share `bot.db` or its WAL), or
  cross-area queries become common enough to want a shared query layer.
