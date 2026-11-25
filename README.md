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
- A web dashboard at `https://shrimp-fried-rice.alexle.dev`: log in with Discord to see the servers where you have **Manage Server**, and each one's reminders and where they stand. Changing them is still `/reminder`'s. A server's owner, and members with the role they allow, also see the Minecraft servers paired with it, and pair a new one there, getting the config for its helper. They can change a server's name, the prefix and colour Discord messages show with in game, and the picture its players get in Discord, or one for a particular player, which its helper applies at once. They see which members have linked a Minecraft name on a server, and can remove any member's link. They can regenerate a server's config if it may have leaked, or remove the server. The owner chooses a role whose members may manage them too.
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
- [Hono](https://hono.dev) with `@hono/node-server` for the web dashboard, in the bot's own process ([decision 0009](docs/decisions/0009-dashboard-on-hono.md)): Discord login, the list of servers a user manages, each server's reminders (read-only so far), and pairing, changing the settings of, regenerating and removing Minecraft servers
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
   - **Bot tab:** switch on the privileged **Message Content Intent** (Privileged Gateway Intents). The bot requests `Guilds`, `GuildExpressions` (keeps each server's emoji list current for the custom-emoji warning), and `GuildMessages` with `MessageContent`, to read Minecraft bridges' chat channels for two-way chat ([decision 0006](docs/decisions/0006-discord-to-minecraft-chat.md)). Discord refuses the login of an app that asks for a privileged intent not switched on (gateway close code 4014, disallowed intents), so the bot won't start without it.
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

Tests are written with [Vitest](https://vitest.dev) and cover the entire codebase — persistence (`core/database.ts`, `reminders/storage.ts`, `ffxiv/recruit/storage.ts` and `minecraft/storage.ts`), the scheduler with its due-reminder checks and the recruit follow-up check, the status embed builder, every event handler, and every command file.

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
- **Dashboard** ([decisions 0008](docs/decisions/0008-dashboard-hostname-and-https.md) and [0009](docs/decisions/0009-dashboard-on-hono.md)): `dashboard/server.ts` serves the Hono app in `dashboard/app.ts` on `127.0.0.1` at `DASHBOARD_PORT` from `.env`, so nothing outside the VM can reach it directly. `cloudflared`, a separate systemd service on the VM, connects out to Cloudflare and passes requests for `https://shrimp-fried-rice.alexle.dev` to it, so the VM opens no inbound port and holds no certificate. Pages: `/health` (answers `ok`, for checking the tunnel) and `/`, which offers Discord login or says who is signed in, with a log-out button. **Login** is Discord OAuth2 with the `identify` scope only: `/login` redirects to Discord's consent page with a random `state`, also kept in a 10-minute `__Host-oauth_state` cookie, and `/auth/callback` refuses a callback whose `state` doesn't match it (so a link from someone else can't sign a visitor in as them), exchanges the code, reads the user's id and name, and revokes Discord's token, as the dashboard never acts as the user on Discord. It then starts a session (`dashboard/sessions.ts`: 32 random bytes in a `__Host-session` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, for 7 days from login; `bot.db` keeps only their SHA-256) and ends the browser's earlier one. `POST /logout` deletes the session. **Servers:** `/servers` lists the servers the bot is in where the signed-in user has Manage Server (the default permission of the commands that change a server's settings; Administrator and the server's owner have it too) or may manage its Minecraft bridges (the server's owner, or a member with the role they allow; decision 0013), linking each page that's theirs. `/servers/<id>/minecraft` lists a server's paired Minecraft servers: each one's name, its chat and alerts channels, and whether messages posted in its chat channel go into the game yet (only once the relay is announced there). `/servers/<id>/minecraft/new` pairs one (`minecraft/pairing.ts`, below): a name and the chat and alerts channels, picked from the text and announcement channels where the member can see and manage webhooks, asked of Discord for the form (a fetch of the member, not the access check's cached answer, so the list names no channel they can't see), and pairing fetches them fresh again, as any change does (decision 0012). Each form carries a one-time token (`dashboard/formTokens.ts`: 30 minutes, in memory, for that server and member), used up before its POST does anything, so a reload of the result page or a double click can't pair twice: the second gets "already sent" (409). It can't redirect after pairing instead, as the secret is only in that one response. A refusal shows the form again, with a new token, with what was sent and what to fix (the name, a channel, the bot's missing permissions by name, Discord's webhook limits); it names a channel only if it's among the member's own choices, else by the ID they sent, as pairing refuses some channels before checking the member can see them. The form's body may be at most 8 KiB (413); a member found to have lost the right gets the same 404 as the guard's, and a Discord or database failure 502. The config for `mcbridge` is shown once, in a read-only box to copy (the pages run no scripts), with the reminders to fill in `logPath`, keep the file private, and tell the chat channel beforehand: only the keys derived from its secret are kept, so it can't be shown again. A server has at most 10. Each bridge on the list links its settings, `/servers/<id>/minecraft/bridges/<bridge>`: its name, the prefix and colour messages from Discord show with in game, and the picture players get in Discord unless one is set for them (generated, their skin's face, none, or the helper's config's choice). Saving checks every field by the helper's own rules (`checkSettingsChange` in `minecraft/bridgeSettings.ts`, using the helper's `serverNameProblem`, `isPrefix` and `isColour`), as the helper ignores a field it would refuse, and a refusal shows the form again with what was sent and every field to fix (400). It asks Discord afresh before saving (decision 0012), queues the new settings on the hub for a connected helper, which applies them at once (one not connected gets them when it connects), held for as long as a session can live without polling (110 s) rather than chat's 30 s, so a helper backing off after a failed poll still gets them (a full queue is logged), and goes back to the Minecraft page (303); it needs no token, as saving twice changes nothing. Its form's body may be at most 4 KiB. Below the form, the page lists the pictures set for particular players, each with a button to remove it, and sets one by Minecraft name: a generated picture picked by the name or one of the 10 by number, their skin's face, or none. It posts to `/servers/<id>/minecraft/bridges/<bridge>/pictures` (a name, and a picture, empty to remove it, handing the player back to the helper's config), checked by the helper's own rules (`checkPictureChange`, using the helper's `isPlayerName` and `isSettingsPicture`), asked of Discord afresh, and sent to the helper the same way; it goes back to the settings page (303), or shows it again with what to fix (400). A bridge has pictures for at most 100 players (`MAX_PICTURES_PER_BRIDGE` in `minecraft/storage.ts`), as all of them go with every connect answer; past that a new name is refused, while one already set can still change. A linked player's own choice comes first, once linking is done. Below the pictures, the page lists members' links on the bridge: each player's name, the member as the bot last saw them (display name and username, from its member cache, filled by their messages and commands and emptied on a restart, so a page view asks Discord nothing; else "not seen since the bot last restarted"), their user ID, which always names them, and the day they linked (UTC). Each has a button posting the name to `/servers/<id>/minecraft/bridges/<bridge>/links/remove`, which asks Discord afresh, deletes that name's link (the name compared without case) and goes back to the settings page (303); it needs no token or page that asks first, as removing twice finds nothing and the player can link again. Its form's body may be at most 1 KiB. Nothing creates links until linking is done, so the list is empty until then. The list also links two pages under `/servers/<id>/minecraft/bridges/<bridge>/`, each asking before it acts, as the pages run no scripts to confirm with; a bridge of another server, or none, is the same 404. `regenerate` says why (a config that may have leaked) and that the helper stops until the new config is in place, then regenerates as the member fetched fresh and shows the new config once, saying to replace its `webhooks` and `bot` and restart `mcbridge`, with any old webhook Discord wouldn't delete named by ID and channel, as it still posts. Its form carries a one-time token like pairing's, as the new secret is only in that answer and a second submit would revoke the config the first one showed. A refusal says what to fix and offers the form again: a channel that's gone means removing the server and pairing it again. `remove` says what goes with the bridge (its webhooks, members' links and players' pictures), removes it as the member fetched fresh, and goes back to the Minecraft page (303), or names the webhooks Discord kept. Removing twice finds nothing the second time, so it needs no token. Both end the helper's session at once (`HelperHub.end`), as its poll held with the old keys would otherwise get chat for up to 50 s more; the old helper connects again and is refused (401). The page says who may manage them: the owner, and members with the allowed role (by name; one no longer in the server is named by its ID). The owner alone (`owner`, the server's owner not in timeout, from the same fetch) gets `/servers/<id>/minecraft/role`, to choose that role among the server's roles from the bot's cache, highest first, leaving out `@everyone` (every member a manager) and roles an integration holds (which can't be given), or to clear it. The page warns that anyone who can give the role can make themselves a manager, and says when the role saved is no longer in the server. Saving asks Discord afresh (`rightsIn` with `fresh`, skipping and replacing the 30 s answer, as decision 0012 asks of a change), so a former owner can't in the 30 seconds after the server changes hands, refuses a role not offered (400), and goes back to the Minecraft page (303), so a reload doesn't send it again. Members who gain or lose the role see it within 30 seconds. `/servers/<id>` is a server's page: its reminders, read-only (changing them is still `/reminder`'s). It shows whether the server's master toggle is on, then each reminder's label, channel, interval, whether it's set to an embed or plain text (the setting: a message with a link, or a channel without Embed Links, still gets plain text), its message, and where it stands (paused, disabled, snoozed, due on the next check, or when it's next sent), worked out by `reminders/reminderState.ts`, which the `/reminder status` embed uses too. Channel names come from the bot's cache, kept current by the `Guilds` intent, so the page asks Discord nothing beyond the access check; a channel not in it shows by its ID. Times are worked out on the server, as the pages run no scripts: "in 95 minutes", with the exact UTC time as a tooltip. The bot asks Discord for the user's membership in each server (`dashboard/access.ts`), rather than its cache: without the privileged Server Members intent it doesn't hear of role changes, so a cached member could keep a permission they've lost. A member in timeout is refused, as Discord refuses them commands. Each answer is reused for 30 seconds, and a check already under way is shared, because every one is a Discord call in the request queue reminder sends and command replies share: reloading a page doesn't call Discord again, and a lost permission takes up to 30 seconds to apply. Every failure, a Discord outage included, is the same 404, so a manager sees "Not found" for their own server while Discord is down. Every route under `/servers/<id>` goes through one guard before its handler, which lets in a member with either right there, then the route requires the one it needs (Manage Server for the reminders, the owner or allowed role for the Minecraft page), from the same fetch of the member. It answers the same 404 whether the bot isn't in the server, the user isn't a member, or they lack the right, so a visitor learns nothing about servers they can't manage. A signed-out visitor of any page that needs login goes back to `/`. Every route is listed in `ROUTE_ACCESS` in `dashboard/app.ts` as public, signed-in, server, bridges, owner or helper (the Minecraft helper's, below), and a test fails for a route served but not listed, or listed but not served, then tries each signed-in, server, bridges and owner route signed out, each server, bridges and owner route as a manager of another server and as a user with only another right there (a bridge manager who isn't the owner, for owner routes), and each helper route without a sealed body (decision 0009: deny by default). A server's own command permissions (Server Settings → Integrations) aren't consulted: Manage Server decides. Form posts are accepted only from the dashboard's own pages: Hono's CSRF check, given the exact public origin, refuses others, including sibling sites under `alexle.dev`. `__Host-` cookies can't be set or overwritten by those sites either. Every response carries Hono's security headers (no framing by other sites, no content sniffing), a Content-Security-Policy allowing nothing but form posts to the dashboard, `Referrer-Policy: same-origin` (Hono's default, `no-referrer`, would make browsers send `Origin: null` on the dashboard's own form posts) and `Cache-Control: no-store`, as pages name the signed-in user. Logins are capped at 30 a minute for the whole dashboard (`dashboard/loginGate.ts`), and refused until Discord's `Retry-After` has passed after it answers 429: they call Discord from the VM's IP, which Discord blocks from its whole API, the bot's reminders and commands included, after 10,000 refused requests in 10 minutes. A visitor over the cap sees "Too many logins". **Rate limits** (`dashboard/rateLimit.ts`, counted in memory, so a restart clears them) answer 429 with `Retry-After` and a page saying to try again: each visitor may send 60 requests a minute (`/health` and the helper's routes aside, which have their own) and complete 5 logins in 10 minutes, counted before the dashboard-wide cap so one visitor can't use it up; each signed-in account may load 30 signed-in pages a minute, whichever sessions and addresses it uses, as those pages may ask Discord about its servers. A visitor is known by `CF-Connecting-IP`, the address Cloudflare adds, which can be trusted only because the server listens on `127.0.0.1` and only `cloudflared` reaches it; an IPv6 address counts by its /64 (one written as IPv4 by that IPv4 address), and requests without a usable address share one count, logged once (`a request came without a usable CF-Connecting-IP`) as that would mean every visitor shares it. Login needs `DISCORD_CLIENT_SECRET` and `DASHBOARD_URL` (the public origin, used for Discord's redirect and the CSRF check, since behind the tunnel a request's own URL is `127.0.0.1`'s) in `.env`; without both, `/login` answers 503 and a missing or malformed one is logged. The server keeps an idle connection open for 100 s, longer than `cloudflared`'s 90, as a connection Node closed first would fail `cloudflared`'s next request on it with a 502. It's off without `DASHBOARD_PORT`, and a malformed port or one already taken is logged and the bot runs on without it. A deploy restarts the bot but not `cloudflared`, which answers with an error page for those seconds. Setup is in [`ORACLE_CLOUD_DEPLOYMENT.md`](ORACLE_CLOUD_DEPLOYMENT.md), sections 12 (the tunnel) and 13 (login).
- **npm install-scripts:** `better-sqlite3`'s native build step (which only builds when no prebuilt binary matches) is explicitly approved via the `allowScripts` field committed in `package.json` — required for npm v12+'s install-script security gating.
- **Pairing a Minecraft bridge** (the dashboard's pages call it, through `minecraft/dashboardPairing.ts`): `minecraft/pairing.ts` makes a bridge's two webhooks ("Minecraft chat" and "Minecraft alerts", in text or announcement channels) and a random 32-byte secret, stores only the two keys derived from it, and returns the `mcbridge.json` to download, with `logPath` left for the host; the secret is shown once. Regenerating replaces the secret and both webhooks and deletes the old ones, so a leaked config stops working in one step; an old webhook Discord won't delete is named, as it still posts. Only the server's owner, or a member with the role they allow, may pair or regenerate, and only with channels where they can see and manage webhooks themselves, so nobody gets a webhook URL for a channel they couldn't make one in. The bot needs View Channel and Manage Webhooks in both, and Read Message History in the chat channel. Everything is checked before a webhook is made, a webhook made for a pairing that then fails is deleted (with its token, so that works without Manage Webhooks), and a server may have 10 bridges. Discord's audit log names the member who paired or regenerated. Removing (`removeBridge`) deletes the bridge's row with its links and pictures first, so its keys stop working and its chat stops being relayed even if Discord won't delete a webhook, then deletes both webhooks with their tokens, naming any Discord kept; a database failure removes nothing and keeps the webhooks. It doesn't check the member's rights in the channels, as they get no webhook URL from it, and a manager must be able to remove a bridge whose channel they can no longer see.
- **Relaying Discord chat to Minecraft** (once a bridge is paired in the dashboard and its helper connects, the plan's A8): `minecraft/events/messageCreate.ts` hands every message the bot receives to `minecraft/relay.ts`, which drops it unread unless it's in the chat channel of a bridge on that server whose relay was announced in that channel (decision 0006: nothing is relayed before the announcement, and moving the chat announces again). Only members' messages go (plain or replies): webhooks, the bridge's own posts of game chat among them, apps, Discord's own messages (and any from its system user) and slash command replies are skipped. It's sent to the helper as the sender's server nickname (else their display name) and plain text: mentions and custom emoji as names (discord.js's `cleanContent`, from its cache), `[image]`, `[file]` or `[sticker]` for each attachment and sticker, and `(reply to Name)`, where a reply to a relayed game message names the player, as the webhook that posted it carries their name; a message with nothing left (a poll, a forward) isn't sent. The helper cleans and cuts it into `tellraw` (`minecraft/bridge/toMinecraft.ts`). At most 5 in a one-second window go to one bridge, the rest dropped; each is queued on the running dashboard's `HelperHub` for the helper's next poll, and its id recorded as the last relayed (`recordRelayedMessage`, for catching up after a restart, decision 0010). Without the dashboard's server there's no endpoint to poll, so nothing is queued. Chat is passed on in memory only, never stored or logged. Reading channels needs the `GuildMessages` and privileged Message Content intents, so the bot now receives every message in every server it's in; it reads only bridges' chat channels. The client caches no message (`core/clientOptions.ts`; discord.js would otherwise keep the last 200 of every channel), so other servers' chat isn't held in memory; nothing reads that cache, as the status embed fetches its message by id. Users and members who post are still cached, by discord.js's default without limit, which is fine for a few servers.
- **Announcing the relay** (decision 0006): before anything posted in a bridge's chat channel goes into the game, `minecraft/announcement.ts` says so there once, through the bridge's chat webhook under the server's name: "Messages posted in this channel now also show in game on **Survival**, under your server nickname. Posting here means you're OK with that. If you play on **Survival**, you can link your account in the dashboard to choose the picture shown with your Minecraft chat here." It's posted when the helper is first active, on any sealed request to the endpoint (not waited on, so the helper's answer doesn't wait on Discord), rather than at pairing (the owner's call, 2026-11-24), so it comes when chat starts to flow and not for a config that's never used. Then the channel is recorded (`announced_channel_id`), and the relay reads it, and so is the announcement's own message id as the last relayed, so a catch-up after a restart never starts before it: after a move, the last relayed message would otherwise be one in the old channel, and the catch-up could relay what was posted in the new one before the announcement. A chat moved to another channel is announced there again the same way. The server's name is shown with its Markdown escaped, and the post allows no mention to ping. A post Discord refuses is tried again on a later request, at most every 10 minutes; one to a webhook Discord says is gone (10015) isn't, until regenerating replaces it, and is logged (its status and Discord's message only, as a REST error's URL holds the webhook's token). Two requests at once post once. Nothing is recorded if the bridge was removed or its chat moved while posting, or once shutdown has begun (`stopDashboard` closes the announcer before the database closes); a post cut off by a restart that way may be posted again after it. It posts through `WebhookClient` with the webhook's token, which needs no permission of the bot's. `index.ts` hands the announcer to the dashboard; without one (tests) nothing is announced.
- **Catching up after a restart** ([decision 0010](docs/decisions/0010-catch-up-after-bot-restarts.md)): the gateway doesn't replay what the bot missed while it was down, as on every deploy, so once ready (`minecraft/events/ready.ts`) `minecraft/catchUp.ts` asks Discord's API for the chat channel of each bridge that relays there and has relayed before (`getBridgesToCatchUp`): messages after the last one relayed, or after 5 minutes ago if that's later, at most 100 in one request. Discord's docs list them newest first without saying which `after` picks, so they're sorted by id, and the oldest 20 members' messages are kept, filtered as live ones are (no webhooks, apps or Discord's own). Meanwhile each bridge's live messages wait (`holdLiveMessages` in `relay.ts`, counted against the 5 a second as they arrive, at most 50): the first of them marks where the catch-up stops, and they follow the caught-up ones, so the game gets them in order. If Discord takes over 10 s, they go anyway and the catch-up is skipped. Messages from the API come without their author's member, and few are cached after a restart, so each author is asked of Discord once (Get Guild Member, which needs no privileged intent) to show their server nickname; one who has left shows under their own name. Caught-up messages wait up to 2 minutes for the helper's next poll, not 30 s, as it may still be backing off from the restart; they're queued together, and the helper paces them into the game. The live relay skips any message at or before the last one relayed, so one both fetched and then delivered by the gateway goes once. A failed fetch is logged (status and Discord's message only) and the live messages go on; without Read Message History Discord answers with no messages. Nothing is recorded once shutdown has closed the hub. A gateway reconnect that resumes its session gets missed events replayed; one that has to start a new session isn't caught up.
- **The helper's connection to the bot** (started by `main.ts` when the config has `bot`, which pairing in the dashboard hands over; the plan's A8): `minecraft/bridge/botClient.ts`, on Node's own `fetch` and `seal.ts`, connects to `bot.url` with the bridge's id (`bot.bridge`, from pairing) and long-polls with its session, passing on each answer's chat and skipping kinds it doesn't know. Each try is sealed again (a new IV, as the bot refuses one it has seen), with a 70 s timeout, longer than the bot holds a poll. A 410 connects again. A 409 sealed by the bot (another helper took over) or a 401 (the secret was regenerated or the bridge removed) stops it until restarted, with one callback for the alert; an unsealed 409 could come from anyone on the way, so it counts as a failure, and so does a 403, which Cloudflare may send for a moment. A sealed `clock` refusal sets the offset from the bot's time and tries again. A 429 waits out `Retry-After`; anything else (a network error, Cloudflare's error pages, an answer that doesn't open) backs off from 1 s, doubling to 60 s, and starts over once answered. A `bot.url` without its trailing slash still reaches `/minecraft/…`; a connect answered without a session backs off; polls answered at once with nothing, as while the bot shuts down, are at least 1 s apart; and a callback that throws is logged, never ending the helper. It logs states, never chat.
- **Into the game** (with `bot`; the plan's A8): `bridge.ts`'s `game` option connects it to the log: the start line, and the startup scan unless it says the server is stopped (when it can't tell, RCON is tried anyway), call `serverUp`; the stop line posts its message, adding "Messages sent here won't reach the game until it's back." while two-way chat is on, then calls `serverDown`. `main.ts` hands it the bot's chat and posts its alerts, and those of a connection taken over or refused, to the alerts channel; RCON not connecting for 2 minutes posts one naming where it tried and saying a stopped server (a crash logs no stop) may be all it is (`rcon.ts`'s `onUnreachable`), and it keeps trying. Shutdown closes the relay after the last log entry is handled, and a closed relay never connects again. `!link` lines are posted as chat until the bot takes link reports (A8f). `minecraft/bridge/gameRelay.ts` reads `server.properties` each time the server starts, as the server reads it only then (beside `logs/`, or the config's `serverPropertiesPath`), and connects RCON (`rcon.ts`) on `127.0.0.1` at `rcon.port`, or the config's `rcon` host and port for Docker or a `server-ip`. It stays off, with one alert per reason naming the fix, if the file can't be read or parsed, `enable-rcon` isn't true, the password is empty, `rcon.port` isn't a port, the server refuses the password, or the password is weak (`weakPasswordReason`: under 12 characters, fewer than 5 different ones, or letters made only of common words such as `minecraft` and `password`), as RCON sends it unencrypted and gives whoever reaches the port the server's console; no alert quotes it. Chat goes in as `tellraw @a` (`toMinecraft.ts`), one command at a time, each at least 1/5 s after the last, in order, with at most 50 waiting and none older than 10 s by its turn (while RCON can't connect, it would otherwise go in minutes late); a command RCON refuses is skipped, never ending the helper; chat sent while the server is down, and what was waiting when it stops, is dropped, not kept for the next start (the owner's call). `online-mode` comes from the same read, for linking: null until a read succeeds and after one fails, which linking takes as offline.
- **The bridge's settings** (the plan's A8): the bot answers each helper connect with the bridge's settings (`minecraft/bridgeSettings.ts`: server name, prefix, colour, default picture and the dashboard's per-player pictures; not linked players', as links stay on the VM), so a restart of either end refreshes them, and the dashboard's settings page queues the same message when it saves them. The helper (`minecraft/bridge/settings.ts`) checks each field as the dashboard would and keeps the config's value for one it refuses or that's absent (a bot of another version), logging only a refused one, links included (the dashboard sets none). The dashboard's values win over the config's, which are the first values and the fallback: a null default picture leaves the config's, and a picture for a name replaces the config's for it. They apply at once, the server's name to every post and the fallback sender, the prefix and colour to `tellraw`. The last ones the bot sent are kept in `mcbridge.settings.json` beside the config (named after it, tagged with the bridge's id so a re-paired config ignores them, saved one at a time in the order sent, each through a temporary file of its own that's renamed over it), and read at startup, so posts keep their name and pictures while the bot is away. It holds no secret.
- **The Minecraft helper's endpoint** (the plan's A8): two-way chat has the helper connect out to the bot, as the Minecraft host can't be reached from outside, on the dashboard's server under `/minecraft/`. `minecraft/helperRoutes.ts` serves `POST /minecraft/connect`, `POST /minecraft/poll` and `POST /minecraft/link`. The helper has no login: each body is sealed with the bridge's keys (`minecraft/bridge/seal.ts`, decision 0009), so Cloudflare, which decrypts HTTPS, never sees relayed chat. A request is checked in this order, cheapest first: the dashboard's CSRF check refuses a form, text or untyped body (403); each address may send 240 a minute; the body may be at most 16 KiB (413, refused by its `Content-Length` or, without one, as soon as it passes that) and must be JSON (415); then a sealed envelope (400); each bridge may send 120 a minute, counted by the id in the envelope before it's looked up (429 with `Retry-After`); an unknown bridge and a seal that doesn't open get the same 401; a request sent twice is refused (400 `replayed`). Those answers are in the clear, as the bot can't yet tell who's asking; every later one is sealed, including a helper whose clock is more than 5 minutes off (400, with the bot's time inside), so nobody on the way can fake one. `connect` starts a session and takes the bridge over from any helper already connected, whose next poll gets 409 (the older copy stops, so two never both relay); `poll` hands over the messages waiting (at most 50 at a time), or holds the request until one arrives, for up to 50 s, inside Cloudflare's 125 s limit. A session ends 60 s after its last poll with none open, or when the bot restarts, and then gets 410, after which the helper connects again. `minecraft/helperHub.ts` keeps it all in memory: sessions, held polls, and messages, each kept up to 30 s for the next poll (200 at most per bridge, then dropped). A held poll whose helper hangs up is let go without taking any messages, so they wait for the next one; an answer lost on the way after that loses its messages (at most once). `link` takes a player's `!link` report (no session needed, as the seal proves the bridge) and answers with the text the helper shows that player alone, worded by the bot so it changes with a deploy; `minecraft/linking.ts` checks it against the codes members were given (memory only, 10 minutes, used once, every code for a name voided after 5 wrong ones), refuses an offline-mode server, asks a player whose login line the helper missed to log in again, and saves the link with the player's Mojang UUID. Nothing gives members codes yet. The per-bridge limit comes before the seal is checked, so someone who sees a bridge's id could use it up with junk; the plan's A8 weighs it.
- **Graceful shutdown:** `systemctl restart`/`stop` send `SIGTERM`, which `src/core/shutdown.ts` handles by stopping the dashboard (it answers the Minecraft helpers' held polls at once, takes no new requests, and finishes those under way, cutting off any still going after 2 s), stopping the scheduler (and waiting for any send already under way), destroying the Discord client, and closing the database connection before the process exits — rather than the process being killed mid-operation. `Ctrl+C` during local `npm run dev` sends `SIGINT`, handled identically.
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
    clientOptions.ts      # the client's intents (Message Content among them) and caches (no messages)
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
    app.ts                # the Hono app and its routes: /health, the home page, Discord login and log-out, the server list, a server's reminders page, and its Minecraft page, the form adding one and each one's settings, regenerate and remove pages; who may reach each (ROUTE_ACCESS), the session and server guards, each server route's own right check (`requires`), CSRF and security headers
    access.ts             # what a user may do in each server: Manage Server, or its Minecraft bridges (owner or allowed role), asked of Discord
    auth.ts               # login's .env settings, and Discord OAuth2: the consent page's URL, the code for the user, revoking the token
    pages.ts              # the pages' HTML, through Hono's escaping html helper
    formTokens.ts         # one-time tokens for forms whose POST mustn't run twice (pairing and regenerating show a secret only once)
    loginGate.ts          # at most 30 logins a minute for the whole dashboard, and none while Discord says to wait
    rateLimit.ts          # per-visitor and per-account rate limits, and the visitor's key from CF-Connecting-IP
    server.ts             # serves it on 127.0.0.1 at DASHBOARD_PORT, and stops it on shutdown
    storage.ts            # login sessions' queries, row type and limits (7 days from login, 10 per user)
    sessions.ts           # session tokens: 32 random bytes in the cookie, only their SHA-256 in bot.db
  minecraft/
    pairing.ts            # pairing, regenerating and removing a bridge: its webhooks, secret and config to download
    dashboardPairing.ts   # what the dashboard's pages use of pairing, from the bot's client: the channels a member may pick, and pairing, regenerating and removing as them, fetched fresh
    bridgeSettings.ts     # a bridge's settings as the helper is sent them, and the dashboard's check of a change by the helper's own rules
    helperRoutes.ts       # the helper's endpoint on the dashboard's server: POST /minecraft/connect, /minecraft/poll and /minecraft/link, sealed, with size and rate limits
    helperHub.ts          # each paired helper's session and lease, messages waiting for its next poll (30 s), and its held poll; ended at once for a bridge regenerated or removed
    announcement.ts       # the relay's opt-in post in a bridge's chat channel, when its helper is first active, retried at most every 10 minutes
    catchUp.ts            # once ready, each relaying bridge's chat missed while the bot was down: at most 20, 5 minutes back, before live ones
    relay.ts              # a message in an announced bridge chat channel to plain text and a name for its helper, at most 5 a second, queued on the dashboard's hub
    linking.ts            # link codes given to members (memory only) and the check of a player's !link report, saving the link
    linkedMember.ts       # a link's member, asked of Discord (not used yet); deletes their links on that server's bridges on Unknown Member or Unknown User only
    storage.ts            # two-way chat's queries and row types: bridges with their webhooks and derived keys, pictures, links, who may manage them
    events/
      ready.ts            # starts the catch-up once the bot is ready
      messageCreate.ts    # hands each message to relay.ts while the dashboard's server is running
      guildDelete.ts      # deletes a server's bridges, pictures, links and settings when the bot leaves it (not on an outage)
    bridge/               # mcbridge, a helper that runs beside a Minecraft server (setup: docs/MINECRAFT_BRIDGE.md; the bot never loads it)
      formats.ts          # the log line prefix of each server flavor (vanilla so far)
      parseLine.ts        # log lines to entries, with stack trace lines attached to the entry they follow
      classify.ts         # an entry to a bridge event (start, stop, join, leave, chat, a `!link` code, alert) or nothing
      alertGate.ts        # holds back routine alerts: lag that doesn't repeat, duplicates, more than a few a minute
      tailer.ts           # polls the log file for new lines, following it when the server rotates or truncates it
      crashReports.ts     # polls the crash-reports folder for new reports, and reads a report's description and exception
      messages.ts         # an event, alert or summary as Discord message text, within 2000 characters
      settings.ts         # the bridge's settings from the bot: checked, put over the config's, cached in mcbridge.settings.json
      sender.ts           # posts through the webhooks: batching, rate limits, retries, no mentions, never crashes the helper
      botClient.ts        # the helper's connection to the bot: connect, long-poll, sealed, with backoff and the clock
      config.ts           # reads and checks mcbridge.json, reporting every problem at once (bot: the address, bridge id and secret pairing wrote; serverPropertiesPath and rcon for two-way chat)
      gameRelay.ts        # chat from the bot into the game: server.properties at each start, the password check, RCON, tellraw at 5 a second, dropped while down
      avatars.ts          # the picture beside a player's chat: their skin's head, a generated one, a URL or none
      rcon.ts             # RCON client for two-way chat (not wired up yet): login, one command at a time with a timeout, reconnecting with backoff, off after a wrong password
      toMinecraft.ts      # a Discord message as a tellraw command (not wired up yet): prefix and colour, one line, \u escapes, cut to fit RCON's limit
      serverProperties.ts # reads the Minecraft server's server.properties: RCON's port and password, or why it's off, and online-mode
      seal.ts             # seals the helper's messages to the bot and its answers (not wired up yet; both ends will use it): keys from the pairing secret with HKDF, AES-256-GCM, the replay window
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
    clientOptions.test.ts           # the intents asked for, and no message cached
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
    app.test.ts                     # the routes through app.request: login's state check, cookies, sessions, CSRF on log-out, escaping, the rate limits
    auth.test.ts                    # login's .env settings, and the OAuth2 calls to a fake Discord (exchange, user, revoke, failures, 429)
    loginGate.test.ts               # the per-minute cap and waiting out Discord's Retry-After
    rateLimit.test.ts               # windows per key, the cap on keys, and visitor keys (IPv4, IPv6 by /64, missing or malformed)
    access.test.ts                  # Manage Server, the owner, asking afresh, not a member, the bot not in the server, Discord failing, the sorted list; each user's rights (owner, allowed role, timeout) from one fetch, and the servers with either
    servers.test.ts                 # the server list, a server's reminders and Minecraft pages, adding a Minecraft server, its settings (saved, sent to its helper and held while its session lives, refusals, the fresh check), players' pictures (set, changed, removed, sent, refused, the cap), regenerating and removing one (asking first, the token, the held poll ended, webhooks Discord kept, refusals), choosing who may manage them, the 404s, and every route declared in ROUTE_ACCESS and tried signed out, as another server's manager, with only the other right or none, or without a seal
    fakeGuilds.ts                   # fake servers whose members have Manage Server or not, their owner, members' roles, cached roles and cached channels, for the two above
    formTokens.test.ts              # a token taken once, for its own form only, expiring, and the cap
    fakePairing.ts                  # pairing as the dashboard sees it: channel choices, and a bridge saved, regenerated or removed, or a refusal
    server.test.ts                  # DASHBOARD_PORT, serving on 127.0.0.1, the keep-alive timeout, a port already taken, stopping (held polls answered at once, the relay announcer closed), and a helper hanging up on a held poll
    storage.test.ts                 # sessions: expiry, deleting, clearing expired ones, the per-user cap
    sessions.test.ts                # tokens: random, stored only hashed, malformed or unknown ones refused, ending one
  minecraft/
    helperHub.test.ts               # with fake timers: held polls, messages kept 30 s and dropped past the cap, taking over, the lease, hanging up, ending a bridge's session, closing
    pairing.test.ts                 # who may pair, the channel and permission checks, cleaning up webhooks on every failure, regenerating (overlapping ones too), removing (links and pictures too, webhooks Discord kept, a database failure)
    dashboardPairing.test.ts        # the channels a member may pick, and pairing, regenerating and removing as them, all fetched fresh; a member gone or Discord failing
    bridgeSettings.test.ts          # a settings change, and a player's picture, trimmed and checked by the helper's rules, every refused field named, and what they save passing the helper's check
    helperRoutes.test.ts            # the endpoint through app.request, sealed as the helper does: the settings with a connect, sessions, 409 and 410, each refusal in order, the clock, the rate limits, the announcer asked on sealed requests only
    announcement.test.ts            # the post and what it records, already announced or moved, one at a time, retries, a gone webhook, shutdown, Markdown, no pings
    catchUp.test.ts                 # what's fetched and kept (5 minutes, 20, oldest first, members only), nicknames, live messages held (rate, 10 s) and after, no repeats, a moved chat, failures, shutdown
    relay.test.ts                   # which messages go (announced channel, members only), the text (attachments, stickers, replies), names, 5 a second per bridge, the last relayed id
    linkedMember.test.ts            # the member asked for uncached, Unknown Member and Unknown User deleting only that server's links, every other failure keeping them, a real Guild fitting
    storage.test.ts                 # bridges (random ids, settings, regenerating), the last relayed id moving forward only, pictures (the cap per bridge), links (replacing, who may change them), deleting
    events/
      messageCreate.test.ts         # chat queued on the running dashboard's hub, and nothing while it's off
      ready.test.ts                 # the catch-up started once ready, with the dashboard's hub or none
      guildDelete.test.ts           # leaving a server deletes its Minecraft data and no other server's
    bridge/
      fixtures/                     # vanilla 26.3 logs from the owner's server (player names replaced), and a hand-written error log, `!link` log and crash report
      parseLine.test.ts             # line prefixes, stack traces, and the fixtures read as entries
      classify.test.ts              # the events found in the fixtures, and each rule (impersonation in chat, `!link` codes, ignore list, levels)
      alertGate.test.ts             # lag repeats, de-duplication with counts, and the per-minute cap
      tailer.test.ts                # against temp files: appends, partial lines, truncation, delete and recreate, rotation
      crashReports.test.ts          # a report's description and trace; against temp folders: old reports, half-written ones, a missing folder
      messages.test.ts              # each event's text, alerts' code blocks cut to fit, summaries
      settings.test.ts              # the bot's settings checked field by field, over the config's, the cache (another bridge's, broken, replaced whole)
      sender.test.ts                # with a stubbed fetch and fake timers: batching (by name and picture), 429s, the username fallback, retries, overflow
      botClient.test.ts             # against the bot's real routes, then each answer from a scripted fake bot: settings handed on, 410, 409 sealed or not, 401, 403, the clock, backoff, 429, timeouts, empty polls, a throwing callback, stopping
      gameRelay.test.ts             # weak passwords, RCON from server.properties or the config, pacing and order, dropping while down, the cap and age limit, each off reason alerted once, online-mode unknown after a failed read, overlapping starts, refused commands, unreachable alerted once
      config.test.ts                # every config problem reported, unknown keys refused, the committed example accepted
      avatars.test.ts               # each avatar choice, offline-mode UUIDs, the pinned name hash, a bundled PNG for every picture
      rcon.test.ts                  # against a fake RCON server on port 0: framing, split reads, one command at a time, timeouts, drops and retry, backoff, stop races, unreachable for 2 minutes
      toMinecraft.test.ts           # the component's shape, quotes and backslashes kept in the string, escapes, § and control characters, cutting to the limit, prefix and colour rules
      serverProperties.test.ts      # Java properties syntax (separators, escapes, continuations, comments), UTF-8 with the ISO-8859-1 fallback, RCON settings and defaults
      seal.test.ts                  # pinned keys and wire format, round trips, every tampering refused (ciphertext, tag, IV, key, bridge, route, direction, reply), envelope checks, the replay window
      bridge.test.ts                # a real log's posts, stack traces flushed when quiet, summaries, the backlog scan, `!link` lines (chat until paired, then reported), crash reports, read errors, the game relay at start and stop and the stop line
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