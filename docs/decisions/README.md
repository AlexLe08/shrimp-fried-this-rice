# Decision records

One short file per decision that shapes the bot or how it's worked on,
numbered in order: what was decided, the context it was decided in, and
what follows from it. They record why things are the way they are, so a
later change can tell a deliberate choice from an accident.

- A new record copies [`0000-template.md`](0000-template.md) as the next
  number, and goes in the PR that acts on the decision (or its own, if
  nothing changes yet).
- A record isn't rewritten once accepted. To change a decision, write a
  new record and set the old one's status to `Superseded by NNNN`, or
  `superseded in part by NNNN (what changed)` when the rest still stands.
- The **Why** is the owner's. Claude drafts Context and Consequences from
  the history and leaves the Why as `TODO(Alex)`.

Design notes from before these records (global command registration,
personal DM settings keyed by user only, warn-but-save on missing channel
permissions, one status embed per server) are in the README's Features
and Design notes sections; the history behind them is in
[`../roadmap.md`](../roadmap.md)'s Done.

| Record | Decision | Status |
| --- | --- | --- |
| [0001](0001-workflow-from-wol-character-panel.md) | Work the way wol-character-panel does: worktrees, small squash-merged PRs, a reviewer pass | Accepted · 2026-11-19 |
| [0002](0002-schema-migrations-with-user-version.md) | Schema migrations in `storage.ts`, versioned by SQLite's `user_version`, applied on startup | Accepted · 2026-11-19 |
| [0003](0003-pre-release-schema-resets.md) | Before the bot has users, a breaking schema change may reset the database instead of migrating | Accepted · 2026-11-19 |
| [0004](0004-feature-storage-modules.md) | `core/database.ts` opens SQLite and owns the schema; each area's storage module queries it | Accepted · 2026-11-20 |
| [0005](0005-minecraft-bridge-webhook-helper.md) | The Minecraft bridge is a separate, dependency-free helper beside the server, posting through a webhook | Accepted · 2026-11-21 |
