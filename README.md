![CI](https://github.com/AlexLe08/shrimp-fried-this-rice/actions/workflows/ci.yml/badge.svg)

![A shrimp hunched over a laptop at a desk](assets/shrimp-check.jpg)

# Shrimp Who Fried That Rice - A Reminder and Free Company Helper Bot

A Discord bot built with **TypeScript** and **discord.js v14** that periodically sends a preset reminder message (e.g. "Check your posture!" or "Time to drink water!") to a server channel, and optionally as a DM to individual users who opt in. For FF14 Free Company servers, it also keeps moderators' list of trial members and reminds them to follow up on each one.

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
- Trial FC member follow-ups (`/recruit`): moderators record trial members of the Free Company by in-game name (they needn't be on Discord) with a short note, up to 100 open at a time. When an entry's follow-up comes due (30 days by default, per server or per entry), the bot posts once in the moderators' channel, pinging the configured role: who they are, when and by whom they were added, the note, and to promote them in game. The entry stays on `/recruit list` until it's resolved (promoted or left), snoozed or removed. Names are autocompleted from the open entries. Managing it needs **Manage Server**, or a role the server grants `/recruit` to in Server Settings → Integrations; every reply is ephemeral, as the notes are about people.
- Minecraft bridge (`mcbridge`): a separate helper that runs beside a vanilla Minecraft server and posts its start and stop, joins and leaves, chat (under each player's name and picture: a generated one, or their skin for players who opt in; shown as typed, with no pings), real errors (with the stack trace; routine warnings and repeats held back) and crash reports to Discord through webhooks. It needs only Node 24 on the Minecraft host and never uses the bot's token. Setup on Windows, macOS and Linux: [`docs/MINECRAFT_BRIDGE.md`](docs/MINECRAFT_BRIDGE.md).
- Restarts are clean: on `SIGTERM`/`SIGINT` (every deploy), a send already under way finishes and is recorded, so it isn't repeated after the restart.

## Design notes

Deliberate choices from before the [decision records](docs/decisions/):

- `/remindme` (personal DM settings) is keyed only by user ID, not per server. Someone in several servers with this bot has one set of personal DM settings across all of them: a personal reminder, independent of any server.
- Only one status embed is tracked per server. Re-running `/reminder status` deletes the previous embed (if it still exists) and posts a new one, even in a different channel.
- `/reminder create` warns, but still saves, when the bot lacks permissions in the channel (View Channel, Send Messages): an admin may grant them afterwards, and the reminder starts sending once they do. Without Embed Links it says the reminder will go out as plain text instead. Custom emoji the bot can't use are warned about the same way, not refused: the fix (inviting the bot, granting Use External Emojis) is the admin's, and the text is theirs.
- A follow-up is posted once, so there's no interval to retry it after. When its channel is gone or Discord refuses the post (missing permissions), that server's follow-ups are paused rather than retried each minute or dropped: they stay pending, `/recruit list` and `/recruit config` say why, and `/recruit config channel:` resumes them once the bot can post there.
- A server's due follow-ups go out together, one post per minute's poll with a single ping, holding as many as fit in a message; the rest follow in the next minute's post. A backlog (follow-ups that came due while paused, or before `/recruit config`) would otherwise ping the role once per entry.
- A follow-up's only ping is the configured role: the note is free text, and the moderator who added the entry is named, not pinged. `/recruit config` takes only a role the moderator could ping themselves (one that allows anyone to mention it, or with their own Mention Everyone), and never `@everyone`, so `/recruit` can't be used to ping a role its user can't. Like `/reminder create`, it warns but saves when the bot lacks permissions in the channel, or can't ping the role itself (the post then goes out without the ping).

## ⚠️ Important: never run local dev against the production bot token

**This bit us once already — worth reading before touching `.env`.** Discord dispatches every interaction to *every* live process connected with the same bot token. Running `npm run dev` locally with the same `DISCORD_TOKEN` as the production VM means **two independent processes handle every command simultaneously**, each with its own separate `bot.db` that silently drifts out of sync with the other. Symptoms we actually hit from this: reminders firing twice, `"Interaction has already been acknowledged"` errors, and a status embed that only updated from whichever process happened to have it tracked.

**The fix:** create a **second, separate Discord Application** in the [Developer Portal](https://discord.com/developers/applications) exclusively for local development, with its own token, invited separately to your test server. Never point your local `.env` at the same token the VM uses. See [Local Setup](#local-setup) below for the exact settings this dev application needs.

## Tech Stack

- [discord.js](https://discord.js.org) v14
- TypeScript 6.0 (pinned for typescript-eslint), executed natively by Node (no compile step in the normal run path — see [Execution Model](#execution-model))
- SQLite via `better-sqlite3` for persistence
- [`age-encryption`](https://github.com/FiloSottile/typage) to encrypt the database's copies off the VM
- [Hono](https://hono.dev) with `@hono/node-server` for the web dashboard, in the bot's own process ([decision 0009](docs/decisions/0009-dashboard-on-hono.md)): Discord login, the list of servers a user manages, and each server's reminders (read-only so far)
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

   Optionally, `DASHBOARD_PORT=8787` (any free port) starts the dashboard, on `http://127.0.0.1:8787` only; `/health` answers `ok`. Without it the dashboard is off. To log in to it locally, also set `DISCORD_CLIENT_SECRET` (the dev application's, from the Developer Portal's OAuth2 page) and `DASHBOARD_URL=http://127.0.0.1:8787`, and add `http://127.0.0.1:8787/auth/callback` to that page's Redirects.

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

   On first run, `bot.db` (a SQLite file) is created automatically in the project root — no manual database setup needed. This local database is entirely separate from the production VM's.

## Testing

Tests are written with [Vitest](https://vitest.dev) and cover the entire codebase — persistence (`core/database.ts`, `reminders/storage.ts` and `ffxiv/recruit/storage.ts`), the scheduler with its due-reminder checks and the recruit follow-up check, the status embed builder, both event handlers, and every command file.

```bash
npm test              # run once and exit
npm run test:watch    # watch mode, re-runs on file changes
npm run test:coverage # run once with a coverage report (terminal + HTML in coverage/)
```

**Current coverage:** ~98% statements / ~99% lines across the codebase (excluding `index.ts`, `deploy-commands.ts`, `src/minecraft/bridge/main.ts`, and `src/core/types/**`, which are deliberately excluded — see below).

**Test isolation:** each test run uses an in-memory SQLite database (`DB_PATH=':memory:'`, set in `test/setup.ts`), completely separate from your real local `bot.db`. Tests never touch real dev or production data. Most test files also call a test-only `__resetForTests()` helper between tests, exported from `core/database.ts` specifically for this purpose (not used anywhere in application code).

**Mocking approach:** rather than a mocking library, tests use Vitest's built-in `vi.fn()` to build small, purpose-built fake objects for discord.js interactions, channels, users, and clients (see `test/mocks.ts` and `test/mockInteraction.ts`). The scheduler (`core/scheduler.ts`) and the reminder checks it runs (`reminders/dueReminders.ts`) are tested through their real public interface, `startScheduler`, using Vitest's fake timers (`vi.advanceTimersByTimeAsync`) rather than exporting their private functions just to make them directly callable.

**What's excluded from the coverage target, and why:**
- `index.ts` and `deploy-commands.ts` — bootstrap/entrypoint scripts that scan the filesystem and immediately connect to Discord on load, with no exported functions to test in isolation. Restructuring them purely to hit a coverage number wasn't judged worthwhile; they're exercised in practice every time the bot runs. `src/minecraft/bridge/main.ts` is excluded for the same reason: it reads `--config` and wires the tested parts (`config.ts`, `bridge.ts`, the tailer and the sender) together. `test/deployCommands.test.ts` does run `deploy-commands.ts`, with a mocked `REST`, to check the exit code the deploy job relies on, but it stays out of the coverage figures. It also matches the command definitions it registers against a snapshot (`test/__snapshots__/`), so a change to a command's name, options, descriptions, choices or permissions fails the tests unless the snapshot is updated (`npx vitest run -u`) in the same PR.
- `src/core/types/**` — interfaces and module augmentation only, no runtime logic to execute.

**Known, accepted gaps within the covered files:** a handful of narrow branches remain untested — e.g. a couple of individual reply-wording branches. These were judged not worth chasing further once the suite comfortably exceeded its coverage goal; none represent untested core logic.

## Continuous Integration

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every push and pull request against `main`:
1. Checks out the repository
2. Sets up Node.js 24
3. Installs dependencies via `npm ci` (not `npm install` — fails loudly if the lockfile is out of sync, rather than silently reconciling)
4. Runs `npm run lint` and `npm run format:check`
5. Runs `npm run typecheck` (`src/`, then `test/`: Vitest strips types without checking them, so the fakes are held to the types they stand in for here)
6. Runs `npm run test:coverage`

No secrets are required for the `test` job — the whole suite runs against mocked/in-memory data with no real Discord connection. On pushes to `main`, a second `deploy` job ships the result (see [Production Deployment](#production-deployment)).

**Merge enforcement:** a branch ruleset on `main` (Settings → Branches → Rulesets) requires this workflow's `test` check to pass before a pull request can be merged, and requires changes to go through a pull request in the first place — so CI passing is a structural gate, not just an informational status. Rulesets were chosen over classic branch protection specifically to be ready for future contributors (per-actor bypass lists, org-wide reusability if this ever becomes a multi-repo setup) and as a deliberate opportunity to learn GitHub's newer system.

## Production Deployment

The bot runs continuously on an **Oracle Cloud Infrastructure "Always Free" VM** (Ampere/ARM, Ubuntu, Node 24 installed via NodeSource), managed as a `systemd` service so it survives reboots and restarts automatically on failure.

Key production-specific details, for future reference:

- **Persistence:** since this is a real VM (not a container-based PaaS), `bot.db` lives on the VM's normal persistent disk — no special volume configuration needed, and it's untouched by deploys (it's git-ignored, and the deploy's `git reset --hard` only resets tracked files).
- **Secrets:** `.env` is created directly on the VM (never committed, never pulled from git) with the production bot token and client ID, and the off-VM backups' upload URL (a secret too) and age public key — using the separate **production** Discord Application, never the local-dev one.
- **Native module:** `better-sqlite3` 13 ships a prebuilt `linux-arm64` binary, so installing it on the VM compiles nothing. npm still runs its `node-gyp` step, which needs `python3`; `build-essential` is the fallback for a version or platform without a prebuilt binary (see [`ORACLE_CLOUD_DEPLOYMENT.md`](ORACLE_CLOUD_DEPLOYMENT.md), section 6).
- **File permissions:** `core/database.ts` makes `bot.db` readable and writable only by the bot's user (`0600`) each time it starts, creating a new one that way, and does the same to any `-wal` and `-shm` files left over; SQLite then creates those two with `bot.db`'s own mode, whatever the umask. Snapshots are `0600` too, and saving one sets any older ones in the folder the same way (ones from before this have the umask's mode, inside the `0700` folder). If the mode can't be changed, the bot logs it and runs anyway.
- **Schema migrations:** run by `core/database.ts` when the bot starts, so the deploy's restart applies any new ones to `bot.db`. A migration that fails rolls back and the bot exits, which the deploy's login check reports; systemd then restarts it every 5 seconds, failing the same way, and no reminders send until a fix is deployed.
- **Backups on the VM:** `core/backup.ts` saves snapshots of `bot.db` in `backups/` beside it (created `0700`, so only the bot's user can open it; untouched by deploys, like `bot.db` itself), each a complete SQLite file written with `VACUUM INTO` and renamed into place once finished. One is saved before pending migrations are applied (`pre-migration-v<version>-<time>.db`, the newest 5 kept); if it can't be saved, the bot exits without migrating. One at the same version from the last 10 minutes is reused, so a migration failing in systemd's restart loop doesn't push the older ones out. A scheduled check saves one a day (`daily-<time>.db`, the newest 7 kept), timed from the newest one's name, so restarts don't reset it; after a failure it tries again an hour later. These don't survive losing the VM's disk; the copies off the VM below do.
- **Backups off the VM** ([decision 0011](docs/decisions/0011-off-vm-backups.md)): `core/offsiteBackup.ts`, a scheduled check after the daily one, encrypts the newest daily snapshot not yet sent to the owner's age public key (`age-encryption`; the VM never holds the key that decrypts) and uploads it with a `PUT` to an Oracle Object Storage bucket through a write-only pre-authenticated URL. The bucket keeps each copy for at least 30 days (a retention rule) and deletes it after 60 (a lifecycle policy). Each attempt uploads under a new name (`<snapshot>.sent-<time>.db.age`), since the retention rule refuses a second upload to a name. What was sent is recorded in `backups/offsite-upload.json` (`0600`), so a restart doesn't resend it. A failed upload is logged without the URL, which is a secret, and tried again an hour later; shutdown aborts one under way. When the newest copy uploaded is over 48 hours old (or, before the first, the oldest snapshot is), the bot DMs the application's owner, once a day until one goes up again, and again after a restart; a DM that fails is logged. It's off without `BACKUP_UPLOAD_URL` and `BACKUP_AGE_RECIPIENT` in `.env` (a local dev bot), and logs why if only one is set or one is malformed. Setup is in [`ORACLE_CLOUD_DEPLOYMENT.md`](ORACLE_CLOUD_DEPLOYMENT.md), section 10. Restoring from either kind of copy is section 11, which sets the old `bot.db` aside with its `-wal` and `-shm`: one left beside the restored file would be replayed into it.
- **Dashboard** ([decisions 0008](docs/decisions/0008-dashboard-hostname-and-https.md) and [0009](docs/decisions/0009-dashboard-on-hono.md)): `dashboard/server.ts` serves the Hono app in `dashboard/app.ts` on `127.0.0.1` at `DASHBOARD_PORT` from `.env`, so nothing outside the VM can reach it directly. `cloudflared`, a separate systemd service on the VM, connects out to Cloudflare and passes requests for `https://shrimp-fried-rice.alexle.dev` to it, so the VM opens no inbound port and holds no certificate. Pages: `/health` (answers `ok`, for checking the tunnel) and `/`, which offers Discord login or says who is signed in, with a log-out button. **Login** is Discord OAuth2 with the `identify` scope only: `/login` redirects to Discord's consent page with a random `state`, also kept in a 10-minute `__Host-oauth_state` cookie, and `/auth/callback` refuses a callback whose `state` doesn't match it (so a link from someone else can't sign a visitor in as them), exchanges the code, reads the user's id and name, and revokes Discord's token, as the dashboard never acts as the user on Discord. It then starts a session (`dashboard/sessions.ts`: 32 random bytes in a `__Host-session` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, for 7 days from login; `bot.db` keeps only their SHA-256) and ends the browser's earlier one. `POST /logout` deletes the session. **Servers:** `/servers` lists the servers the bot is in where the signed-in user has Manage Server (the default permission of the commands that change a server's settings; Administrator and the server's owner have it too), and `/servers/<id>` is a server's page: its reminders, read-only (changing them is still `/reminder`'s). It shows whether the server's master toggle is on, then each reminder's label, channel, interval, whether it sends an embed or plain text, its message, and where it stands (paused, disabled, snoozed, due on the next check, or when it's next sent), worked out by `reminders/reminderState.ts`, which the `/reminder status` embed uses too. Channel names come from the bot's cache, kept current by the `Guilds` intent, so the page asks Discord nothing beyond the access check; a channel not in it shows by its ID. Times are worked out on the server, as the pages run no scripts: "in 95 minutes", with the exact UTC time as a tooltip. The bot asks Discord for the user's membership in each server (`dashboard/access.ts`), rather than its cache: without the privileged Server Members intent it doesn't hear of role changes, so a cached member could keep a permission they've lost. A member in timeout is refused, as Discord refuses them commands. Each answer is reused for 30 seconds, and a check already under way is shared, because every one is a Discord call in the request queue reminder sends and command replies share: reloading a page doesn't call Discord again, and a lost permission takes up to 30 seconds to apply. A per-visitor limit on signed-in pages is still to come. Every failure, a Discord outage included, is the same 404, so a manager sees "Not found" for their own server while Discord is down. Every route under `/servers/<id>` goes through one guard before its handler, and answers the same 404 whether the bot isn't in the server, the user isn't a member, or they can't manage it, so a visitor learns nothing about servers they can't manage. A signed-out visitor of any page that needs login goes back to `/`. Every route is listed in `ROUTE_ACCESS` in `dashboard/app.ts` as public, signed-in or server, and a test fails for a route served but not listed, or listed but not served, then tries each non-public route signed out and each server route as a manager of another server (decision 0009: deny by default). A server's own command permissions (Server Settings → Integrations) aren't consulted: Manage Server decides. Form posts are accepted only from the dashboard's own pages: Hono's CSRF check, given the exact public origin, refuses others, including sibling sites under `alexle.dev`. `__Host-` cookies can't be set or overwritten by those sites either. Every response carries Hono's security headers (no framing by other sites, no content sniffing), a Content-Security-Policy allowing nothing but form posts to the dashboard, `Referrer-Policy: same-origin` (Hono's default, `no-referrer`, would make browsers send `Origin: null` on the dashboard's own form posts) and `Cache-Control: no-store`, as pages name the signed-in user. Logins are capped at 30 a minute for the whole dashboard (`dashboard/loginGate.ts`), and refused until Discord's `Retry-After` has passed after it answers 429: they call Discord from the VM's IP, which Discord blocks from its whole API, the bot's reminders and commands included, after 10,000 refused requests in 10 minutes. A visitor over the cap sees "Too many logins". Login needs `DISCORD_CLIENT_SECRET` and `DASHBOARD_URL` (the public origin, used for Discord's redirect and the CSRF check, since behind the tunnel a request's own URL is `127.0.0.1`'s) in `.env`; without both, `/login` answers 503 and a missing or malformed one is logged. The server keeps an idle connection open for 100 s, longer than `cloudflared`'s 90, as a connection Node closed first would fail `cloudflared`'s next request on it with a 502. It's off without `DASHBOARD_PORT`, and a malformed port or one already taken is logged and the bot runs on without it. A deploy restarts the bot but not `cloudflared`, which answers with an error page for those seconds. Setup is in [`ORACLE_CLOUD_DEPLOYMENT.md`](ORACLE_CLOUD_DEPLOYMENT.md), sections 12 (the tunnel) and 13 (login).
- **npm install-scripts:** `better-sqlite3`'s native build step (which only builds when no prebuilt binary matches) is explicitly approved via the `allowScripts` field committed in `package.json` — required for npm v12+'s install-script security gating.
- **Graceful shutdown:** `systemctl restart`/`stop` send `SIGTERM`, which `src/core/shutdown.ts` handles by stopping the dashboard (it takes no new requests, and finishes those under way, cutting off any still going after 2 s), stopping the scheduler (and waiting for any send already under way), destroying the Discord client, and closing the database connection before the process exits — rather than the process being killed mid-operation. `Ctrl+C` during local `npm run dev` sends `SIGINT`, handled identically.
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
| `/recruit add <name> [note] [days]` | Records a trial FC member by in-game name, with an optional note (up to 300 characters). The follow-up is due in `days` (1–365), or the server's default. |
| `/recruit list [page]` | Lists open trial members, soonest follow-up first: when each is due (or overdue, or already followed up), who added them and when, and the note. A long list is split into pages. |
| `/recruit edit <name> [note] [new_name] [days]` | Changes an entry's note or name, or its follow-up to `days` after it was added; a new date posts the follow-up again when it comes. |
| `/recruit resolve <name> <outcome>` | Closes an entry as promoted or left, taking it off the list. |
| `/recruit snooze <name> <days>` | Moves the follow-up to `days` from now, to ask again later. |
| `/recruit remove <name>` | Deletes an entry added by mistake. |
| `/recruit config [channel] [role] [no_ping] [days]` | Sets the channel follow-ups are posted in, the role pinged (`no_ping:True` stops pinging), and the default days for new entries; options left out keep their value. With no options, shows the settings. Resumes paused follow-ups. |

## Project Structure

```
src/
  index.ts                # client setup, command/event loading, login (systemd starts this file, so it stays here)
  deploy-commands.ts      # registers slash commands globally with Discord's API
  core/                   # bot plumbing and Discord helpers any area may use
    database.ts           # opens SQLite (bot.db in the project root), creates the tables and runs schema migrations for every area
    backup.ts             # snapshots of the database in backups/: before migrating, and a daily scheduled check
    offsiteBackup.ts      # the daily snapshot, encrypted with age, uploaded to Oracle Object Storage; a DM to the owner when uploads stop
    loadCommands.ts       # finds every area's commands/ and events/ files; the one command list for index.ts and deploy-commands.ts
    shutdown.ts           # graceful SIGTERM/SIGINT handling — stops the dashboard and the scheduler, destroys the client, closes the database
    scheduler.ts          # polling loop — runs a list of named checks every 60 s, one at a time each, and waits for them on shutdown
    eventListener.ts      # wraps each event handler so a rejection is logged, not an unhandled crash
    customEmoji.ts        # finds custom emoji in a reminder's text that the bot can't use where it sends
    discord.ts            # shared Discord helpers: ephemeral replies, timestamps, fitting text under Discord's limits, refused requests
    types/
      command.ts          # shared Command interface
      event.ts            # shared Event interface, typed by the event's name
      types.d.ts          # module augmentation (adds `commands`/`cooldowns` to discord.js's Client)
    events/
      ready.ts            # ClientReady handler — also starts the scheduler with every area's checks
      interactionCreate.ts  # routes slash command and autocomplete interactions, handles cooldowns + errors (with a hardened, self-catching error fallback)
  reminders/              # /reminder, /remindme and the reminders they send
    commands/
      reminder.ts         # /reminder: its subcommand list, label autocomplete, and routing to a subcommand
      remindme.ts         # /remindme
    subcommands/          # one file per /reminder subcommand (create, edit, list, ...): its options and its handler
      helpers.ts          # finding a reminder by label, and the channel permission and custom emoji warnings
    options.ts            # option builders shared by /reminder and /remindme (label, interval, message, embed)
    storage.ts            # the reminders' queries, row types and limits (guild settings, guild reminders, user settings, status message tracking)
    dueReminders.ts       # the scheduler's reminder checks — asks storage.ts for due server and DM reminders and sends them
    snooze.ts             # snooze durations and after-snooze choices shared by /reminder and /remindme
    reminderMessage.ts    # builds what a reminder sends: an embed with its mentions above it, or plain text when it has a link or is set to it
    reminderState.ts      # where a server's reminder stands (paused, disabled, snoozed, due, next send), for the status embed and the dashboard
    statusEmbed.ts        # builds the /reminder status embed; replaces the tracked status message, and refreshes it when reminders change
  ffxiv/                  # FF14 Free Company features
    commands/
      recruit.ts          # /recruit: its subcommand list, name autocomplete, and routing to a subcommand
    recruit/
      subcommands/        # one file per /recruit subcommand (add, list, edit, ...): its options and its handler
        helpers.ts        # finding an open entry by name, shared options, and why follow-ups are held back
      storage.ts          # the trial members' queries, row types and limits (settings, entries, due follow-ups)
      followUps.ts        # the scheduler's follow-up check — posts each due follow-up once, pausing a server whose posts fail
  dashboard/              # the web dashboard (decisions 0008 and 0009)
    app.ts                # the Hono app and its routes: /health, the home page, Discord login and log-out, the server list and a server's reminders page; who may reach each (ROUTE_ACCESS), the session and server guards, CSRF and security headers
    access.ts             # which servers a user may manage: Manage Server, asked of Discord on each request
    auth.ts               # login's .env settings, and Discord OAuth2: the consent page's URL, the code for the user, revoking the token
    pages.ts              # the pages' HTML, through Hono's escaping html helper
    loginGate.ts          # at most 30 logins a minute for the whole dashboard, and none while Discord says to wait
    server.ts             # serves it on 127.0.0.1 at DASHBOARD_PORT, and stops it on shutdown
    storage.ts            # login sessions' queries, row type and limits (7 days from login, 10 per user)
    sessions.ts           # session tokens: 32 random bytes in the cookie, only their SHA-256 in bot.db
  minecraft/
    bridge/               # mcbridge, a helper that runs beside a Minecraft server (setup: docs/MINECRAFT_BRIDGE.md; the bot never loads it)
      formats.ts          # the log line prefix of each server flavor (vanilla so far)
      parseLine.ts        # log lines to entries, with stack trace lines attached to the entry they follow
      classify.ts         # an entry to a bridge event (start, stop, join, leave, chat, a `!link` code, alert) or nothing
      alertGate.ts        # holds back routine alerts: lag that doesn't repeat, duplicates, more than a few a minute
      tailer.ts           # polls the log file for new lines, following it when the server rotates or truncates it
      crashReports.ts     # polls the crash-reports folder for new reports, and reads a report's description and exception
      messages.ts         # an event, alert or summary as Discord message text, within 2000 characters
      sender.ts           # posts through the webhooks: batching, rate limits, retries, no mentions, never crashes the helper
      config.ts           # reads and checks mcbridge.json, reporting every problem at once
      avatars.ts          # the picture beside a player's chat: their skin's head, a generated one, a URL or none
      rcon.ts             # RCON client for two-way chat (not wired up yet): login, one command at a time with a timeout, reconnecting with backoff, off after a wrong password
      toMinecraft.ts      # a Discord message as a tellraw command (not wired up yet): prefix and colour, one line, \u escapes, cut to fit RCON's limit
      serverProperties.ts # reads the Minecraft server's server.properties (not wired up yet): RCON's port and password, or why it's off, and online-mode
      bridge.ts           # wiring: lines to entries to events, alerts through the gate, posts to the right webhook, `!link` codes to the bot once paired (not yet)
      main.ts             # the entrypoint (npm run mcbridge): --config, the tailer, crash watcher and sender, shutdown on SIGINT, SIGTERM, SIGHUP (and SIGBREAK on Windows)
test/
  setup.ts                       # points core/database.ts at an in-memory DB before any test imports it
  tsconfig.json                  # type-checks the tests with src's options (npm run typecheck); leaves npm run build as it is
  mocks.ts                        # shared fake Client/guild/channel/user builders (scheduler, embed + command tests)
  mockInteraction.ts               # shared fake ChatInputCommandInteraction/AutocompleteInteraction builder (command + event tests)
  deployCommands.test.ts           # a failed registration sets a nonzero exit code; the registered definitions match a snapshot (mocked REST and dotenv)
  __snapshots__/                   # Vitest snapshots: every command's registered definition
  core/
    database/
      closeDatabase.test.ts         # isolated in its own file — closing the DB connection is irreversible within a test file
      migrations.test.ts            # migrations on a database built like production's before them, and on a new one; the snapshot taken first
      databasePath.test.ts          # the default database path is bot.db in the project root
      filePermissions.test.ts       # bot.db and its -wal and -shm files are made owner-only, new or existing; a failed chmod is logged
    loadCommands.test.ts            # which command and event files are found, and the commands they load
    shutdown.test.ts                # gracefulShutdown orchestration tests (mocked dashboard, scheduler + database)
    backup.test.ts                  # snapshots (owner-only) and pruning on a real file; the daily check through the scheduler with fake timers
    offsiteBackup.test.ts           # uploads decrypted with a test key (mocked fetch), retries, shutdown, the stale-upload DM, .env and the owner lookup
    scheduler.test.ts               # the polling loop with fake checks: every poll, a throwing check, the overlap guard, stopping
    eventListener.test.ts           # rejected and throwing handlers are logged
    customEmoji.test.ts             # which custom emoji are warned about, per server, channel permission and DM
    discord.test.ts                 # the shared Discord helpers in core/discord.ts
    events/
      ready.test.ts
      interactionCreate.test.ts     # includes a direct regression test for the production crash incident
  reminders/
    storage/
      storage.test.ts               # initial smoke test
      guildReminders.test.ts        # CRUD + uniqueness constraint tests
      guildSettings.test.ts         # master-toggle upsert/read tests
      guildStatusMessages.test.ts   # status-message tracking upsert/read/delete tests
      userSettings.test.ts          # upsert behavior + due-reminder tests for DM settings
      dueReminders.test.ts          # due-reminder boundary/edge-case tests for guild reminders
      snooze.test.ts                # snoozing, cancelling, and the after-snooze choices, for reminders and DMs
    commands/                       # reminder (and its label autocomplete), remindme, and snooze (both commands' snooze options) tests
    subcommands/
      registered.test.ts            # every file in src/reminders/subcommands/ is registered by /reminder
    statusEmbed.test.ts             # buildReminderStatusEmbed + refreshGuildStatusMessage tests
    reminderMessage.test.ts         # the embed a reminder sends, which mentions go above it, and when it's plain text
    dueReminders.test.ts            # the reminder checks run by the scheduler, using fake timers
    dueRemindersCheckFailure.test.ts  # a poll whose storage query throws is logged, not a crash (mocks storage, so its own file)
  ffxiv/
    commands/
      recruit.test.ts               # every /recruit subcommand and the name autocomplete
    recruit/
      storage.test.ts               # entries, open-name uniqueness, settings, pausing, and the due query
      followUps.test.ts             # the follow-up check run by the scheduler, using fake timers
      subcommands/
        registered.test.ts          # every file in src/ffxiv/recruit/subcommands/ is registered by /recruit
  dashboard/
    app.test.ts                     # the routes through app.request: login's state check, cookies, sessions, CSRF on log-out, escaping
    auth.test.ts                    # login's .env settings, and the OAuth2 calls to a fake Discord (exchange, user, revoke, failures, 429)
    loginGate.test.ts               # the per-minute cap and waiting out Discord's Retry-After
    access.test.ts                  # Manage Server, not a member, the bot not in the server, Discord failing, the sorted list
    servers.test.ts                 # the server list, a server's reminders page, the 404s, and every route declared in ROUTE_ACCESS and tried signed out and as another server's manager
    fakeGuilds.ts                   # fake servers whose members have Manage Server or not, and their cached channels, for the two above
    server.test.ts                  # DASHBOARD_PORT, serving on 127.0.0.1, the keep-alive timeout, a port already taken, and stopping
    storage.test.ts                 # sessions: expiry, deleting, clearing expired ones, the per-user cap
    sessions.test.ts                # tokens: random, stored only hashed, malformed or unknown ones refused, ending one
  minecraft/
    bridge/
      fixtures/                     # vanilla 26.3 logs from the owner's server (player names replaced), and a hand-written error log, `!link` log and crash report
      parseLine.test.ts             # line prefixes, stack traces, and the fixtures read as entries
      classify.test.ts              # the events found in the fixtures, and each rule (impersonation in chat, `!link` codes, ignore list, levels)
      alertGate.test.ts             # lag repeats, de-duplication with counts, and the per-minute cap
      tailer.test.ts                # against temp files: appends, partial lines, truncation, delete and recreate, rotation
      crashReports.test.ts          # a report's description and trace; against temp folders: old reports, half-written ones, a missing folder
      messages.test.ts              # each event's text, alerts' code blocks cut to fit, summaries
      sender.test.ts                # with a stubbed fetch and fake timers: batching (by name and picture), 429s, the username fallback, retries, overflow
      config.test.ts                # every config problem reported, unknown keys refused, the committed example accepted
      avatars.test.ts               # each avatar choice, offline-mode UUIDs, the pinned name hash, a bundled PNG for every picture
      rcon.test.ts                  # against a fake RCON server on port 0: framing, split reads, one command at a time, timeouts, drops and retry, backoff, stop races
      toMinecraft.test.ts           # the component's shape, quotes and backslashes kept in the string, escapes, § and control characters, cutting to the limit, prefix and colour rules
      serverProperties.test.ts      # Java properties syntax (separators, escapes, continuations, comments), UTF-8 with the ISO-8859-1 fallback, RCON settings and defaults
      bridge.test.ts                # a real log's posts, stack traces flushed when quiet, summaries, the backlog scan, `!link` lines (chat until paired, then reported), crash reports, read errors
```

Repository workflow (for Claude Code and contributors) lives in `CLAUDE.md`, `scripts/` (worktrees, `check.sh` mirroring CI, cleanup after merges), `docs/decisions/`, and `docs/roadmap.md` (status and next steps). Setting up the Minecraft bridge: `docs/MINECRAFT_BRIDGE.md`.

## Available Scripts

| Script | Purpose |
|---|---|
| `npm start` | Runs the bot once via native Node TypeScript execution |
| `npm run dev` | Runs the bot with `--watch`, auto-restarting on file changes |
| `npm run build` | Compiles to `dist/` via `tsc` (not part of the normal run/deploy path) |
| `npm run lint` | ESLint (typescript-eslint), including unhandled-promise checks on `src/` |
| `npm run format` / `format:check` | Formats with Prettier / checks formatting (CI runs the check) |
| `npm run typecheck` | Type-checks `src/`, then `test/` (`test/tsconfig.json`, same options), without emitting output |
| `npm test` | Runs the Vitest test suite once and exits (see [Testing](#testing)) |
| `npm run test:watch` | Runs the test suite in watch mode |
| `npm run test:coverage` | Runs the test suite once with a coverage report |
| `npm run deploycommands` | Registers slash commands globally with Discord's API |
| `npm run mcbridge -- --config <file>` | Runs the Minecraft bridge helper on the Minecraft host (not the bot; see `mcbridge.example.json`) |
| `npm run zip` | Bundles the project (excluding `node_modules`, `dist`, `.env`, `bot.db`, etc.) into a shareable zip |

## License

MIT, see [LICENSE](LICENSE).