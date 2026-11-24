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
- A record the owner hasn't decided yet has the status
  `Proposed · date`. It can be edited or withdrawn until the owner writes
  the Why and sets it to `Accepted · date`; until then it isn't in force.
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
| [0005](0005-minecraft-bridge-webhook-helper.md) | The Minecraft bridge is a separate, dependency-free helper beside the server, posting through a webhook | Accepted · 2026-11-21; superseded in part by 0006 (Discord to Minecraft chat) and 0007 (players linking their Discord account) |
| [0006](0006-discord-to-minecraft-chat.md) | Discord to Minecraft chat goes through the bot (the helper connects out to its endpoint) and is set up in the dashboard | Accepted · 2026-11-22; superseded in part by 0008 (reached through a Cloudflare Tunnel with no inbound port; the helper's traffic is encrypted end to end across it) and by 0010 (chat missed while the bot restarts is caught up) |
| [0007](0007-players-choose-their-picture-from-discord.md) | Players in the Discord server choose their picture in the dashboard, after linking their account by a code typed in game | Accepted · 2026-11-22 |
| [0008](0008-dashboard-hostname-and-https.md) | The dashboard is served at `shrimp-fried-rice.alexle.dev` (the owner's domain, DNS on Cloudflare) through a Cloudflare Tunnel | Accepted · 2026-11-23 |
| [0009](0009-dashboard-on-hono.md) | The dashboard runs in the bot on Hono (`hono`, `@hono/node-server`), pages through its `html` helper; the helper long-polls | Accepted · 2026-11-23 |
| [0010](0010-catch-up-after-bot-restarts.md) | The bot catches up on bridge chat it missed while restarting, from the channel's recent history | Accepted · 2026-11-23 |
| [0011](0011-off-vm-backups.md) | Encrypted copies of `bot.db` (age, to the owner's public key, with `age-encryption`) go daily to Oracle Object Storage through a write-only URL | Proposed · 2026-11-23 |
