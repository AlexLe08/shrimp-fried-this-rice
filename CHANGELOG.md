# Changelog

All notable changes to this project are documented here.

## [1.0.0]

### Added
- Core bot framework: TypeScript + discord.js v14, native Node execution (no compile step), command/event loading, module augmentation for a typed `Client`
- Utility commands: `/ping`, `/echo`, `/info`, `/server`, `/user`
- Per-command, per-user cooldowns
- `/reload` — hot-reloads a single command file without restarting the bot
- SQLite persistence layer (`storage.ts`) for guild settings, guild reminders, and personal DM settings
- Polling scheduler (`scheduler.ts`) that sends due reminders
- Full CRUD for server reminders (`/reminder create|edit|list|toggle|delete|master`), including a 20-reminder-per-server cap
- Personal DM reminders (`/remindme`), independent of any server setting, invocable via direct DM once commands went global
- Live-updating status embed (`/reminder status`) with Discord relative timestamps, refreshed automatically whenever a reminder fires or its settings change
- Graceful shutdown handling (`shutdown.ts`) — clean scheduler stop, Discord client destroy, and database close on `SIGTERM`/`SIGINT`, with a force-exit safety net
- Vitest test suite (~96% statements / ~97% lines) covering persistence, scheduling, embeds, event handling, shutdown, and every command
- GitHub Actions CI (type-check + test on every push/PR) and CD (automated, approval-gated deploy to production on merge to `main`)
- Branch ruleset on `main` requiring CI to pass and changes to go through a pull request
- Production deployment on an Oracle Cloud "Always Free" VM, managed via systemd

### Fixed
- `getDueGuildReminders` used an inner `JOIN` against `guild_settings`, silently excluding every reminder belonging to a server that had never explicitly run `/reminder master` — fixed with a `LEFT JOIN` and explicit `NULL` handling, found by the test suite
- An unhandled promise rejection could crash the entire bot process if both a command's execution *and* the fallback error reply failed — fixed with a nested `try`/`catch`, now covered by a direct regression test
- Running local development against the same bot token as production caused duplicate reminder sends and interaction-acknowledgment races, due to Discord dispatching events to both processes simultaneously against two independently-drifting databases — resolved by using a dedicated Discord Application for local development
- The initial CD deploy script continued running subsequent steps even after `git pull` failed, due to missing `set -e` — fixed, and `git pull` itself replaced with `git fetch` + `git reset --hard` to prevent the underlying conflict entirely

### Changed
- Slash command registration switched from guild-scoped to global, enabling multi-server use and direct-DM invocation of `/remindme`