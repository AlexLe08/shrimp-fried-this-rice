# 0003: Before the bot has users, a breaking schema change may reset the database

Status: Accepted · 2026-11-19

## Context

[Decision 0002](0002-schema-migrations-with-user-version.md) added
migrations: an append-only list, applied on startup, never edited once
merged. Additive changes (a new column with a default, a new table) are
cheap that way. A change that renames, drops or retypes a column, or
reshapes a table, is not: SQLite can only do most of those by copying the
table, and the old shape's quirks have to be carried across.

The bot is deployed, but it has no users yet: production's `reminders.db`
holds only test data. Some of the schema's current shape is complicated
because of how it grew rather than by design. One example: `guild_settings`
has no row until `/reminder master` is first used, so the due query
needs a `LEFT JOIN` with `NULL` handling, and the README records the bug
an inner join caused. Another: `last_sent_at = 0` stands for "never sent".

The owner raised this while reviewing the PR that adds the first migration
(snoozing), and asked for this rule in the same PR.

## Decision

While README's Status says the bot is pre-release, a schema change that
isn't additive may reset the database instead of migrating it:

1. Rewrite the `CREATE TABLE` statements in `storage.ts` to the new shape.
2. Empty `MIGRATIONS`, so `user_version` starts again from 0.
3. Before approving that deploy, the owner stops the service on the VM
   and deletes `reminders.db` and its `-wal`/`-shm` files.

Additive changes still go through migrations, so the setup keeps
working. The phase ends when the owner removes the pre-release line from
README's Status and the matching sentence from CLAUDE.md. After that,
every change is a migration, as decision 0002 describes.

**Why:** 

There are many more features that will be added to this bot before it sees practical use. Before we commit to supporting older schemas, I wish to solidify this data structure with these future features in mind first before we have "official" users, so breaking changes should be acceptable before practical use.

## Consequences

- The schema can be reshaped to fit the code while that's cheap, so later
  migrations start from a deliberate design, not an accumulated one.
- A reset deletes every reminder and DM setting in production, including
  ones a user would have set up without the owner knowing. That is why the
  phase is a visible line in README's Status, removed on purpose, rather
  than a judgement made at the time.
- A resetting PR's Deploys line must say so and list the manual step. If
  the database isn't deleted, the new code meets old tables:
  `CREATE TABLE IF NOT EXISTS` leaves them as they are, and the first
  query on a missing column fails. The deploy's login check doesn't catch
  that, because the bot still logs in.
- The wipe is done by hand on the VM, not by code in the repository. A
  migration that drops tables would stay in the list and could run again
  against real data after the phase ends.
