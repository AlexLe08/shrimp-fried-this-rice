![CI](https://github.com/AlexLe08/shrimp-fried-this-rice/actions/workflows/ci.yml/badge.svg)

![A shrimp hunched over a laptop at a desk](assets/shrimp-check.jpg)

# Shrimp Who Fried That Rice - A Posture & Hydration Reminder Bot

A Discord bot built with **TypeScript** and **discord.js v14** that periodically sends a preset reminder message (e.g. "Check your posture!" or "Time to drink water!") to a server channel, and optionally as a DM to individual users who opt in.

## Status

**Pre-release:** the bot has no users yet, so a breaking schema change may reset production's database instead of migrating it ([decision 0003](docs/decisions/0003-pre-release-schema-resets.md)). Removing this line ends that; from then on every schema change is a migration.

Deployed and running in production. What's done, what's next, and candidates for later are in [`docs/roadmap.md`](docs/roadmap.md). How it was built, and the incidents that shaped it: [`CASESTUDY.md`](CASESTUDY.md).

## Features

- Slash commands registered globally: the bot works in any server it's invited to, and `/remindme` also works in a DM with it.
- Server reminders (`/reminder`): up to 20 per server, each posting its message to a channel every 5 to 1440 minutes, with a server-wide master toggle. Managing them needs **Manage Server**.
- A self-updating status embed (`/reminder status`) listing every reminder and when it next sends, refreshed whenever one sends or changes.
- Personal DM reminders (`/remindme`), opt-in and independent of any server.
- Reminders arrive as an embed by default: the reminder's label as the title (`Reminder` for DMs), its message, and how often it repeats. Each server reminder, and each user's DM reminders, can be set to plain text instead with the `embed` option. Discord doesn't ping mentions inside an embed, so a server reminder's mentions are also posted just above it (not ones in code, spoilers, or escaped). A message with a link is sent as plain text, as before embeds, because Discord doesn't preview links in a bot message that has its own embed; a link in code, a spoiler or `<https://…>` doesn't count. In a channel where the bot lacks Embed Links, every reminder is sent as plain text.
- Custom emoji: a reminder can use the server's own emoji, and those of other servers the bot is in where it has Use External Emojis (in a DM, being in the emoji's server is enough). Discord shows any other custom emoji as `:name:` text, embed or not, so `/reminder create`, `/reminder edit` and `/remindme` name the ones that will when the message is saved, with the server each comes from and a link to the channel.
- Each command has a 3-second per-user cooldown.
- Label autocomplete: wherever `/reminder` asks for an existing reminder's `label` (`edit`, `toggle`, `snooze`, `unsnooze`, `delete`), Discord lists the server's reminders to pick from, each with its interval, channel, and whether it's disabled or snoozed. Labels starting with what's typed come first. A typed label that matches none still gets the usual "No reminder found".
- Snoozing: a server reminder (`/reminder snooze`) or your own DM reminders (`/remindme snooze:`) can be held back for 30 minutes to a week, then resume by themselves. Each snooze chooses what happens when it ends: send one right away if one was missed (the default), or wait a full interval. Active snoozes show in `/reminder list`, `/reminder status` and `/remindme`.
- Failures are handled per reminder: one whose channel was deleted (or can't take messages) is disabled, and shows as disabled in `/reminder status`; re-enable it with `/reminder edit` to a new channel, then `/reminder toggle`. A send Discord refuses (missing permissions, DMs closed) is retried after the reminder's own interval; network and Discord server errors on the next minute's poll.
- Restarts are clean: on `SIGTERM`/`SIGINT` (every deploy), a send already under way finishes and is recorded, so it isn't repeated after the restart.

## Design notes

Deliberate choices from before the [decision records](docs/decisions/):

- `/remindme` (personal DM settings) is keyed only by user ID, not per server. Someone in several servers with this bot has one set of personal DM settings across all of them: a personal reminder, independent of any server.
- Only one status embed is tracked per server. Re-running `/reminder status` deletes the previous embed (if it still exists) and posts a new one, even in a different channel.
- `/reminder create` warns, but still saves, when the bot lacks permissions in the channel (View Channel, Send Messages): an admin may grant them afterwards, and the reminder starts sending once they do. Without Embed Links it says the reminder will go out as plain text instead. Custom emoji the bot can't use are warned about the same way, not refused: the fix (inviting the bot, granting Use External Emojis) is the admin's, and the text is theirs.

## ⚠️ Important: never run local dev against the production bot token

**This bit us once already — worth reading before touching `.env`.** Discord dispatches every interaction to *every* live process connected with the same bot token. Running `npm run dev` locally with the same `DISCORD_TOKEN` as the production VM means **two independent processes handle every command simultaneously**, each with its own separate `reminders.db` that silently drifts out of sync with the other. Symptoms we actually hit from this: reminders firing twice, `"Interaction has already been acknowledged"` errors, and a status embed that only updated from whichever process happened to have it tracked.

**The fix:** create a **second, separate Discord Application** in the [Developer Portal](https://discord.com/developers/applications) exclusively for local development, with its own token, invited separately to your test server. Never point your local `.env` at the same token the VM uses. See [Local Setup](#local-setup) below for the exact settings this dev application needs.

## Tech Stack

- [discord.js](https://discord.js.org) v14
- TypeScript 6.0 (pinned for typescript-eslint), executed natively by Node (no compile step in the normal run path — see [Execution Model](#execution-model))
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
   - **Bot tab:** no privileged gateway intents need to be enabled — this project only requests the non-privileged `Guilds` and `GuildExpressions` intents (the second keeps each server's emoji list current for the custom-emoji warning).
   - **OAuth2 → URL Generator → Scopes:** `bot`, `applications.commands`
   - **Bot Permissions:** Send Messages, Embed Links (reminders and the `/reminder status` embed are embeds), Read Message History (required to fetch/delete previously-posted status embeds), View Channel; optionally Use External Emojis, for reminders that use emoji from another server the bot is in
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

**Current coverage:** ~98% statements / ~99% lines across the codebase (excluding `index.ts`, `deploy-commands.ts`, and `src/types/**`, which are deliberately excluded — see below).

**Test isolation:** each test run uses an in-memory SQLite database (`DB_PATH=':memory:'`, set in `test/setup.ts`), completely separate from your real local `reminders.db`. Tests never touch real dev or production data. Most test files also call a test-only `__resetForTests()` helper between tests, exported from `storage.ts` specifically for this purpose (not used anywhere in application code).

**Mocking approach:** rather than a mocking library, tests use Vitest's built-in `vi.fn()` to build small, purpose-built fake objects for discord.js interactions, channels, users, and clients (see `test/mocks.ts` and `test/mockInteraction.ts`). `scheduler.ts` is tested through its real public interface using Vitest's fake timers (`vi.advanceTimersByTimeAsync`) rather than exporting its private polling functions just to make them directly callable.

**What's excluded from the coverage target, and why:**
- `index.ts` and `deploy-commands.ts` — bootstrap/entrypoint scripts that scan the filesystem and immediately connect to Discord on load, with no exported functions to test in isolation. Restructuring them purely to hit a coverage number wasn't judged worthwhile; they're exercised in practice every time the bot runs. `test/deployCommands.test.ts` does run `deploy-commands.ts`, with a mocked `REST`, to check the exit code the deploy job relies on, but it stays out of the coverage figures. It also matches the command definitions it registers against a snapshot (`test/__snapshots__/`), so a change to a command's name, options, descriptions, choices or permissions fails the tests unless the snapshot is updated (`npx vitest -u`) in the same PR.
- `src/types/**` — interfaces and module augmentation only, no runtime logic to execute.

**Known, accepted gaps within the covered files:** a handful of narrow branches remain untested — e.g. a couple of individual reply-wording branches, and the scheduler's overlap-guard "skip this tick" path (which would require a more elaborate concurrent-timer test to trigger deliberately). These were judged not worth chasing further once the suite comfortably exceeded its coverage goal; none represent untested core logic.

## Continuous Integration

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every push and pull request against `main`:
1. Checks out the repository
2. Sets up Node.js 24
3. Installs dependencies via `npm ci` (not `npm install` — fails loudly if the lockfile is out of sync, rather than silently reconciling)
4. Runs `npm run lint` and `npm run format:check`
5. Runs `npm run typecheck`
6. Runs `npm run test:coverage`

No secrets are required for the `test` job — the whole suite runs against mocked/in-memory data with no real Discord connection. On pushes to `main`, a second `deploy` job ships the result (see [Production Deployment](#production-deployment)).

**Merge enforcement:** a branch ruleset on `main` (Settings → Branches → Rulesets) requires this workflow's `test` check to pass before a pull request can be merged, and requires changes to go through a pull request in the first place — so CI passing is a structural gate, not just an informational status. Rulesets were chosen over classic branch protection specifically to be ready for future contributors (per-actor bypass lists, org-wide reusability if this ever becomes a multi-repo setup) and as a deliberate opportunity to learn GitHub's newer system.

## Production Deployment

The bot runs continuously on an **Oracle Cloud Infrastructure "Always Free" VM** (Ampere/ARM, Ubuntu, Node 24 installed via NodeSource), managed as a `systemd` service so it survives reboots and restarts automatically on failure.

Key production-specific details, for future reference:

- **Persistence:** since this is a real VM (not a container-based PaaS), `reminders.db` lives on the VM's normal persistent disk — no special volume configuration needed, and it's untouched by deploys (it's git-ignored, and the deploy's `git reset --hard` only resets tracked files).
- **Secrets:** `.env` is created directly on the VM (never committed, never pulled from git) with the production bot token and client ID — using the separate **production** Discord Application, never the local-dev one.
- **Native module:** `better-sqlite3` 13 ships a prebuilt `linux-arm64` binary, so installing it on the VM compiles nothing. npm still runs its `node-gyp` step, which needs `python3`; `build-essential` is the fallback for a version or platform without a prebuilt binary (see [`ORACLE_CLOUD_DEPLOYMENT.md`](ORACLE_CLOUD_DEPLOYMENT.md), section 6).
- **Schema migrations:** run by `storage.ts` when the bot starts, so the deploy's restart applies any new ones to `reminders.db`. A migration that fails rolls back and the bot exits, which the deploy's login check reports; systemd then restarts it every 5 seconds, failing the same way, and no reminders send until a fix is deployed.
- **npm install-scripts:** `better-sqlite3`'s native build step (which only builds when no prebuilt binary matches) is explicitly approved via the `allowScripts` field committed in `package.json` — required for npm v12+'s install-script security gating.
- **Graceful shutdown:** `systemctl restart`/`stop` send `SIGTERM`, which `src/shutdown.ts` handles by stopping the scheduler (and waiting for any send already under way), destroying the Discord client, and closing the database connection before the process exits — rather than the process being killed mid-operation. `Ctrl+C` during local `npm run dev` sends `SIGINT`, handled identically.
- **Service management:** the bot runs under a systemd unit (`discordbotshrimp.service`). Common commands:
  ```bash
  sudo systemctl status discordbotshrimp     # check if running
  sudo systemctl restart discordbotshrimp    # restart (deploys do this)
  journalctl -u discordbotshrimp -f          # view live logs
  ```
- **Deploying updates:** automatic on merge to `main`. The `deploy` job in `.github/workflows/ci.yml` runs after `test` passes, waits for the owner's approval (the `production` environment), then SSHes into the VM and runs `git fetch`, `git reset --hard origin/main`, `npm ci`, restarts the service, and re-runs `deploycommands`, in that order (service restart before command redeployment, so a command-registration hiccup never blocks a code fix from taking effect; a failed registration still turns the job red). It then waits, until 60 s after the restart, for the bot's `Ready! Logged in as` line in the service's journal, and fails the job if the bot hasn't logged in by then; a failed registration doesn't skip this wait. Approving one run deploys whatever `main` is at that moment. Setup and secrets: [`ORACLE_CLOUD_DEPLOYMENT.md`](ORACLE_CLOUD_DEPLOYMENT.md), section 9.

## Commands

| Command | Description |
|---|---|
| `/reminder create <label> <channel> <interval> <message> [embed]` | Creates a new server reminder (max 20 per server). Interval must be 5–1440 minutes. `embed:False` sends it as plain text (default: an embed). Warns (but still saves) if the bot lacks permissions in the target channel, and about custom emoji it can't use there. |
| `/reminder edit <label> [channel] [interval] [message] [embed]` | Edits one or more fields of an existing reminder, including whether it's an embed; unspecified fields are left unchanged. A new message or channel warns about custom emoji the bot can't use there. |
| `/reminder list` | Lists the server's master toggle state, followed by every configured reminder and its status, noting the ones sent as plain text (ephemeral, text-only). |
| `/reminder status` | Posts a public, self-updating embed listing every reminder and a live "next fire" timestamp for each. Deletes any previously-posted status embed for this server first. |
| `/reminder toggle <label> <enabled>` | Enables or disables a specific reminder, until toggled back. |
| `/reminder snooze <label> <duration> [after]` | Holds a reminder back for 30 minutes, 1, 2, 4 or 8 hours, 1 day, 3 days or 1 week; it resumes by itself. `after` picks what happens when the snooze ends: send one right away if one was missed (the default), or wait a full interval. Snoozing again replaces the snooze. |
| `/reminder unsnooze <label>` | Ends a snooze early, as if it had ended now. |
| `/reminder delete <label>` | Deletes a reminder. |
| `/reminder master <enabled>` | Server-wide kill switch — overrides all individual reminders when off. Requires **Manage Server** permission; guild-only. |
| `/remindme [enabled] [interval] [message] [embed]` | Views (if called with no options) or updates your personal DM reminder settings; `embed:False` sends them as plain text. Can be run in a server or directly in a DM with the bot. A new message warns about custom emoji the bot can't use. |
| `/remindme snooze:<duration> [after_snooze]` | Snoozes your DM reminders, with the same durations and `after_snooze` choices as `/reminder snooze`; `snooze:Cancel snooze` ends one early. Can be combined with the options above. |
| `/remindme reset:true` | Deletes your personal DM reminder settings entirely. |

## Project Structure

```
src/
  index.ts              # client setup, command/event loading, login
  deploy-commands.ts    # registers slash commands globally with Discord's API
  scheduler.ts          # polling loop — checks storage.ts for due reminders and sends them
  shutdown.ts            # graceful SIGTERM/SIGINT handling — stops the scheduler, destroys the client, closes the database
  eventListener.ts      # wraps each event handler so a rejection is logged, not an unhandled crash
  storage.ts            # SQLite data-access layer (guild settings, guild reminders, user settings, status message tracking) and schema migrations
  snooze.ts             # snooze durations and after-snooze choices shared by /reminder and /remindme
  reminderMessage.ts    # builds what a reminder sends: an embed with its mentions above it, or plain text when it has a link
  customEmoji.ts        # finds custom emoji in a reminder's text that the bot can't use where it sends
  reminderEmbed.ts       # builds the /reminder status embed; also refreshes the tracked status message when reminders change
  types/
    command.ts           # shared Command interface
    types.d.ts            # module augmentation (adds `commands`/`cooldowns` to discord.js's Client)
  commands/
    reminderCore/          # reminder (guildreminder.ts), remindme
  events/
    ready.ts               # ClientReady handler — also starts the scheduler
    interactionCreate.ts   # routes slash command and autocomplete interactions, handles cooldowns + errors (with a hardened, self-catching error fallback)
test/
  setup.ts                       # points storage.ts at an in-memory DB before any test imports it
  mocks.ts                        # shared fake Client/channel/user builders (scheduler + embed tests)
  mockInteraction.ts               # shared fake ChatInputCommandInteraction/AutocompleteInteraction builder (command + event tests)
  reminderEmbed.test.ts            # buildReminderStatusEmbed + refreshGuildStatusMessage tests
  reminderMessage.test.ts          # the embed a reminder sends, which mentions go above it, and when it's plain text
  customEmoji.test.ts              # which custom emoji are warned about, per server, channel permission and DM
  scheduler.test.ts                # scheduler tests, using fake timers
  schedulerCheckFailure.test.ts    # a poll whose storage query throws is logged, not a crash (mocks storage, so its own file)
  shutdown.test.ts                  # gracefulShutdown orchestration tests (mocked scheduler + storage)
  eventListener.test.ts            # rejected and throwing handlers are logged
  deployCommands.test.ts           # a failed registration sets a nonzero exit code; the registered definitions match a snapshot (mocked REST and dotenv)
  __snapshots__/                   # Vitest snapshots: every command's registered definition
  storage/
    storage.test.ts                 # initial smoke test
    closeDatabase.test.ts           # isolated in its own file — closing the DB connection is irreversible within a test file
    guildReminders.test.ts          # CRUD + uniqueness constraint tests
    guildSettings.test.ts           # master-toggle upsert/read tests
    guildStatusMessages.test.ts     # status-message tracking upsert/read/delete tests
    userSettings.test.ts            # upsert behavior + due-reminder tests for DM settings
    dueReminders.test.ts            # due-reminder boundary/edge-case tests for guild reminders
    snooze.test.ts                  # snoozing, cancelling, and the after-snooze choices, for reminders and DMs
    migrations.test.ts              # migrations on a database built like production's before them, and on a new one
  commands/
    reminderCore/                   # guildreminder (and its label autocomplete), remindme, and snooze (both commands' snooze options) tests
  events/
    ready.test.ts
    interactionCreate.test.ts        # includes a direct regression test for the production crash incident
```

Repository workflow (for Claude Code and contributors) lives in `CLAUDE.md`, `scripts/` (worktrees, `check.sh` mirroring CI, cleanup after merges), `docs/decisions/`, and `docs/roadmap.md` (status and next steps).

## Available Scripts

| Script | Purpose |
|---|---|
| `npm start` | Runs the bot once via native Node TypeScript execution |
| `npm run dev` | Runs the bot with `--watch`, auto-restarting on file changes |
| `npm run build` | Compiles to `dist/` via `tsc` (not part of the normal run/deploy path) |
| `npm run lint` | ESLint (typescript-eslint), including unhandled-promise checks on `src/` |
| `npm run format` / `format:check` | Formats with Prettier / checks formatting (CI runs the check) |
| `npm run typecheck` | Type-checks the project without emitting output |
| `npm test` | Runs the Vitest test suite once and exits (see [Testing](#testing)) |
| `npm run test:watch` | Runs the test suite in watch mode |
| `npm run test:coverage` | Runs the test suite once with a coverage report |
| `npm run deploycommands` | Registers slash commands globally with Discord's API |
| `npm run zip` | Bundles the project (excluding `node_modules`, `dist`, `.env`, `reminders.db`, etc.) into a shareable zip |

## License

MIT, see [LICENSE](LICENSE).