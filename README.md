![CI](https://github.com/your-username/your-repo-name/actions/workflows/ci.yml/badge.svg)

# Posture & Hydration Reminder Bot

A Discord bot built with **TypeScript** and **discord.js v14** that periodically sends a preset reminder message (e.g. "Check your posture!" or "Time to drink water!") to a server channel, and optionally as a DM to individual users who opt in.

## Status

**Core feature set is complete, deployed, and running in production:**
- Slash command loading and registration (global — works in any server the bot is invited to, plus direct DMs)
- Event handling (`ClientReady`, `InteractionCreate`)
- Per-command, per-user cooldowns
- A `/reload` command for hot-reloading a single command file without restarting the bot
- SQLite-backed persistence (`src/storage.ts`) for server and per-user settings
- A polling scheduler (`src/scheduler.ts`) that sends reminders when they're due, hardened against overlapping poll ticks
- Full CRUD management of server reminders, plus a server-wide master toggle
- A live-updating status embed (`/reminder status`) listing all of a server's reminders with Discord relative timestamps for their next fire time; automatically re-posts/edits itself whenever a reminder fires or its settings change (`src/reminderEmbed.ts`)
- Personal opt-in DM reminders, independent of any server setting — configurable directly via DM with the bot
- A handful of utility commands (`/ping`, `/echo`, `/info`, `/server`, `/user`) used to shake out the framework
- Deployed 24/7 on an Oracle Cloud "Always Free" VM, managed via systemd (see [Production Deployment](#production-deployment))
- A Vitest test suite covering **~96% of statements / ~97% of lines** across the entire codebase — persistence, scheduling, embeds, event handling, and every command (see [Testing](#testing))
- A GitHub Actions CI workflow running type-checking and the full test suite on every push/PR (see [Continuous Integration](#continuous-integration))

**Notable bugs caught by the test suite:**
- `getDueGuildReminders` originally used an inner `JOIN` against `guild_settings`, which silently excluded *every* reminder belonging to a server that had never explicitly run `/reminder master` (since no row exists there until that command is used). This meant a server that created reminders but never touched the master toggle could have had them never fire, with no visible error. Fixed by switching to a `LEFT JOIN` with explicit `NULL` handling, correctly treating "no row" the same as "enabled," matching the schema's stated default.
- A dedicated test in `interactionCreate.test.ts` directly reproduces the production incident where a command's own error *and* the fallback error-reply itself both failed, which had previously crashed the whole bot process via an unhandled promise rejection. This test locks in the fix (a nested `try`/`catch` around the fallback reply) so a future refactor can't silently reintroduce that crash.

**Deferred / future enhancements (not blocking, not started):**
- Custom-styled embeds for the periodic reminder *messages themselves* (the `/reminder status` overview already uses an embed — this item is specifically about the message a reminder actually sends when it fires, which is still plain text; it still supports pasted image/GIF/YouTube/Spotify links via Discord's automatic link unfurling)
- True file/audio attachments on reminders (bundled sound files or user-uploaded audio)
- Autocomplete for custom server emojis in reminder messages (Discord's own slash-command input fields don't always convert a picked custom emoji into its proper renderable format — this is a Discord client limitation, not a bug in this bot; standard Unicode emojis are unaffected)
- Enforcing a minimum coverage threshold in CI (via Vitest's `coverage.thresholds`), so a future PR that drops coverage fails the build automatically, rather than coverage being a one-time achievement
- Publishing the HTML coverage report as a downloadable CI artifact (via `actions/upload-artifact`), so it can be browsed per-run without checking out and re-running locally

**Known, deliberate design notes:**
- `/remindme` (personal DM settings) is keyed only by user ID, not per-server. If the same person is in multiple servers this bot is in, they share one set of personal DM reminder settings across all of them — this matches the original spec (a personal reminder independent of any server), not a bug.
- Only one status embed is tracked per server at a time. Re-running `/reminder status` deletes the previous embed (if it still exists) and posts a new one, even if run in a different channel than before.
- `refreshGuildStatusMessage` (in `reminderEmbed.ts`) and `startScheduler` (in `scheduler.ts`) both accept a discord.js `Client`, but their test mocks only implement the handful of methods actually used (`channels.fetch`, `users.fetch`, `guilds.fetch`) rather than the full real interface. This requires a `client as unknown as Client` double-cast in the test files, since the mock doesn't structurally match discord.js's much larger `Client` type. A cleaner long-term fix would be narrowing each function's parameter type to a small custom interface describing only what it actually needs (interface segregation) — which would let the mocks satisfy the type directly with no cast at all. Deferred for now since the current approach is a standard, contained pattern for test mocks; worth revisiting if the project leans further into strict typing as a demonstrated practice.

## ⚠️ Important: never run local dev against the production bot token

**This bit us once already — worth reading before touching `.env`.** Discord dispatches every interaction to *every* live process connected with the same bot token. Running `npm run dev` locally with the same `DISCORD_TOKEN` as the production VM means **two independent processes handle every command simultaneously**, each with its own separate `reminders.db` that silently drifts out of sync with the other. Symptoms we actually hit from this: reminders firing twice, `"Interaction has already been acknowledged"` errors, and a status embed that only updated from whichever process happened to have it tracked.

**The fix:** create a **second, separate Discord Application** in the [Developer Portal](https://discord.com/developers/applications) exclusively for local development, with its own token, invited separately to your test server. Never point your local `.env` at the same token the VM uses. See [Local Setup](#local-setup) below for the exact settings this dev application needs.

## Tech Stack

- [discord.js](https://discord.js.org) v14
- TypeScript, executed natively by Node (no compile step in the normal run path — see [Execution Model](#execution-model))
- SQLite via `better-sqlite3` for persistence
- [Vitest](https://vitest.dev) for testing, with `@vitest/coverage-v8` for coverage reporting

## Execution Model

This project runs TypeScript **directly via Node's native type-stripping support** rather than compiling to a `dist/` folder first. This requires **Node.js v23.6.0 or later** (the production VM runs Node 24 LTS). There is a `build`/`dist` path available (`npm run build`) for local use if ever needed, but it isn't part of the normal dev/run/deploy workflow.

Slash commands are registered **globally** (via `deploycommands`), so they're available in any server the bot is invited to, and `/remindme` can also be run directly in a DM with the bot. Global command changes can take up to an hour to propagate to all clients (in practice, often much faster).

## Prerequisites

- Node.js v23.6.0+ (see [Execution Model](#execution-model) above)
- A Discord account and **two** registered applications in the [Discord Developer Portal](https://discord.com/developers/applications) — one for production, one dedicated to local development (see the warning above)
- A bot token from each application

## Local Setup

1. **Create a dedicated local-dev Discord Application** (do not reuse the production one — see the warning above):
   - **Bot tab:** no privileged gateway intents need to be enabled — this project only requests the non-privileged `Guilds` intent.
   - **OAuth2 → URL Generator → Scopes:** `bot`, `applications.commands`
   - **Bot Permissions:** Send Messages, Embed Links (required for the `/reminder status` embed), Read Message History (required to fetch/delete previously-posted status embeds), View Channel
   - Use the generated URL to invite this dev bot to your test server.

2. **Clone and install dependencies**
   ```bash
   git clone <your-repo-url>
   cd shrimp-fried-this-rice
   npm install
   ```

3. **Configure environment variables**

   Create a `.env` file in the project root, using your **dev** application's credentials:
   ```env
   DISCORD_TOKEN=your-dev-bot-token-here
   DISCORD_CLIENT_ID=your-dev-application-client-id
   DISCORD_GUILD_ID=your-test-server-id
   ```
   > ⚠️ Never commit `.env` to version control. It's already listed in `.gitignore`.

4. **Register slash commands**
   ```bash
   npm run deploycommands
   ```
   Re-run this any time a command's options/subcommands change.

5. **Run the bot**
   ```bash
   npm run dev      # development, auto-restarts on file changes
   npm start        # runs the bot once, no auto-restart
   ```

   On first run, `reminders.db` (a SQLite file) is created automatically in the project root — no manual database setup needed. This local database is entirely separate from the production VM's.

## Testing

Tests are written with [Vitest](https://vitest.dev) and cover the entire codebase — persistence (`storage.ts`), the scheduler, the status embed builder, both event handlers, and every command file.

```bash
npm test              # run once and exit
npm run test:watch    # watch mode, re-runs on file changes
npm run test:coverage # run once with a coverage report (terminal + HTML in coverage/)
```

**Current coverage:** ~96% statements / ~97% lines across the codebase (excluding `index.ts`, `deploy-commands.ts`, and `src/types/**`, which are deliberately excluded — see below).

**Test isolation:** each test run uses an in-memory SQLite database (`DB_PATH=':memory:'`, set in `test/setup.ts`), completely separate from your real local `reminders.db`. Tests never touch real dev or production data. Most test files also call a test-only `__resetForTests()` helper between tests, exported from `storage.ts` specifically for this purpose (not used anywhere in application code).

**Mocking approach:** rather than a mocking library, tests use Vitest's built-in `vi.fn()` to build small, purpose-built fake objects for discord.js interactions, channels, users, and clients (see `test/mocks.ts` and `test/mockInteraction.ts`). `scheduler.ts` is tested through its real public interface using Vitest's fake timers (`vi.advanceTimersByTimeAsync`) rather than exporting its private polling functions just to make them directly callable.

**What's excluded from the coverage target, and why:**
- `index.ts` and `deploy-commands.ts` — bootstrap/entrypoint scripts that scan the filesystem and immediately connect to Discord on load, with no exported functions to test in isolation. Restructuring them purely to hit a coverage number wasn't judged worthwhile; they're exercised in practice every time the bot runs.
- `src/types/**` — interfaces and module augmentation only, no runtime logic to execute.

**Known, accepted gaps within the covered files:** a handful of narrow branches remain untested — e.g. a couple of individual reply-wording branches, and the scheduler's overlap-guard "skip this tick" path (which would require a more elaborate concurrent-timer test to trigger deliberately). These were judged not worth chasing further once the suite comfortably exceeded its coverage goal; none represent untested core logic.

## Continuous Integration

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every push and pull request against `main`:
1. Checks out the repository
2. Sets up Node.js 24
3. Installs dependencies via `npm ci` (not `npm install` — fails loudly if the lockfile is out of sync, rather than silently reconciling)
4. Runs `npm run typecheck`
5. Runs `npm run test:coverage`

No secrets are required — the whole suite runs against mocked/in-memory data with no real Discord connection.

## Production Deployment

The bot runs continuously on an **Oracle Cloud Infrastructure "Always Free" VM** (Ampere/ARM, Ubuntu, Node 24 installed via NodeSource), managed as a `systemd` service so it survives reboots and restarts automatically on failure.

Key production-specific details, for future reference:

- **Persistence:** since this is a real VM (not a container-based PaaS), `reminders.db` lives on the VM's normal persistent disk — no special volume configuration needed, and it's untouched by deploys (it's git-ignored, so `git pull` never affects it).
- **Secrets:** `.env` is created directly on the VM (never committed, never pulled from git) with the production bot token and IDs — using the separate **production** Discord Application, never the local-dev one.
- **Native module builds:** `better-sqlite3` compiles from source on first install on this ARM architecture, requiring `build-essential` and `python3` to be installed on the VM (see deployment notes/history for the full one-time VM setup steps).
- **npm install-scripts:** `better-sqlite3`'s native build step is explicitly approved via the `allowScripts` field committed in `package.json` — required for npm v12+'s install-script security gating.
- **Service management:** the bot runs under a systemd unit (`discordbot.service`). Common commands:
  ```bash
  sudo systemctl status discordbot     # check if running
  sudo systemctl restart discordbot    # apply a code update
  journalctl -u discordbot -f          # view live logs
  ```
- **Deploying updates:** a helper script (`~/deploy.sh` on the VM, not part of this repo) runs `git pull`, `npm install`, restarts the service, and re-runs `deploycommands`, in that order (service restart before command redeployment, so a command-registration hiccup never blocks a code fix from taking effect).

## Commands

| Command | Description |
|---|---|
| `/ping` | Replies with "Pong!" — basic connectivity check. Has a 5-second cooldown. |
| `/echo` | Sends your input message to a chosen text channel, optionally ephemeral. |
| `/info user [target]` | Shows info about a server member (or yourself, if no target given). |
| `/info server` | Shows basic info about the current server. |
| `/server` | Shows the server's name and member count. |
| `/user` | Shows the invoking user's username and server join date. |
| `/reload <command>` | Hot-reloads a single command file's code without restarting the bot. |
| `/reminder create <label> <channel> <interval> <message>` | Creates a new server reminder. Interval must be 5–1440 minutes. Warns (but still saves) if the bot lacks permissions in the target channel. |
| `/reminder edit <label> [channel] [interval] [message]` | Edits one or more fields of an existing reminder; unspecified fields are left unchanged. |
| `/reminder list` | Lists the server's master toggle state, followed by every configured reminder and its status (ephemeral, text-only). |
| `/reminder status` | Posts a public, self-updating embed listing every reminder and a live "next fire" timestamp for each. Deletes any previously-posted status embed for this server first. |
| `/reminder toggle <label> <enabled>` | Enables or disables a specific reminder. |
| `/reminder delete <label>` | Deletes a reminder. |
| `/reminder master <enabled>` | Server-wide kill switch — overrides all individual reminders when off. Requires **Manage Server** permission; guild-only. |
| `/remindme [enabled] [interval] [message]` | Views (if called with no options) or updates your personal DM reminder settings. Can be run in a server or directly in a DM with the bot. |
| `/remindme reset:true` | Deletes your personal DM reminder settings entirely. |

## Project Structure

```
src/
  index.ts              # client setup, command/event loading, login
  deploy-commands.ts    # registers slash commands globally with Discord's API
  scheduler.ts          # polling loop — checks storage.ts for due reminders and sends them
  storage.ts            # SQLite data-access layer (guild settings, guild reminders, user settings, status message tracking)
  reminderEmbed.ts       # builds the /reminder status embed; also refreshes the tracked status message when reminders change
  types/
    command.ts           # shared Command interface
    types.d.ts            # module augmentation (adds `commands`/`cooldowns` to discord.js's Client)
  commands/
    utility/              # ping, echo, info, server, user, reload
    reminderCore/          # reminder (guildreminder.ts), remindme
  events/
    ready.ts               # ClientReady handler — also starts the scheduler
    interactionCreate.ts   # routes slash command interactions, handles cooldowns + errors (with a hardened, self-catching error fallback)
test/
  setup.ts                       # points storage.ts at an in-memory DB before any test imports it
  mocks.ts                        # shared fake Client/channel/user builders (scheduler + embed tests)
  mockInteraction.ts               # shared fake ChatInputCommandInteraction builder (command + event tests)
  reminderEmbed.test.ts            # buildReminderStatusEmbed + refreshGuildStatusMessage tests
  scheduler.test.ts                # scheduler tests, using fake timers
  storage/
    storage.test.ts                 # initial smoke test
    guildReminders.test.ts          # CRUD + uniqueness constraint tests
    guildSettings.test.ts           # master-toggle upsert/read tests
    guildStatusMessages.test.ts     # status-message tracking upsert/read/delete tests
    userSettings.test.ts            # upsert behavior + due-reminder tests for DM settings
    dueReminders.test.ts            # due-reminder boundary/edge-case tests for guild reminders
  commands/
    utility/                        # ping, echo, info, server, user, reload tests
    reminderCore/                   # guildreminder, remindme tests
  events/
    ready.test.ts
    interactionCreate.test.ts        # includes a direct regression test for the production crash incident
```

## Available Scripts

| Script | Purpose |
|---|---|
| `npm start` | Runs the bot once via native Node TypeScript execution |
| `npm run dev` | Runs the bot with `--watch`, auto-restarting on file changes |
| `npm run build` | Compiles to `dist/` via `tsc` (not part of the normal run/deploy path) |
| `npm run typecheck` | Type-checks the project without emitting output |
| `npm test` | Runs the Vitest test suite once and exits (see [Testing](#testing)) |
| `npm run test:watch` | Runs the test suite in watch mode |
| `npm run test:coverage` | Runs the test suite once with a coverage report |
| `npm run deploycommands` | Registers slash commands globally with Discord's API |
| `npm run zip` | Bundles the project (excluding `node_modules`, `dist`, `.env`, `reminders.db`, etc.) into a shareable zip |

## Roadmap

- [ ] Custom-styled embeds for the periodic reminder messages themselves
- [ ] True file/audio attachment support (bundled sound files, or user-uploaded)
- [ ] Autocomplete for custom server emojis in reminder messages
- [ ] Snooze/pause command
- [ ] Enforce a minimum coverage threshold in CI
- [ ] Publish the HTML coverage report as a CI artifact
- [ ] Consider narrowing `refreshGuildStatusMessage`'s and `startScheduler`'s `Client` parameter to a smaller custom interface, to eliminate the `as unknown as Client` casts in test mocks
- [ ] Web dashboard for configuration (longer-term idea)

## License

MIT