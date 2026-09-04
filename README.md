# Posture & Hydration Reminder Bot

A Discord bot built with **TypeScript** and **discord.js v14** that periodically sends a preset reminder message (e.g. "Check your posture!" or "Time to drink water!") to a server channel, and optionally as a DM to individual users who opt in.

## Status

**Core feature set is complete and working end-to-end:**
- Slash command loading and registration
- Event handling (`ClientReady`, `InteractionCreate`)
- Per-command, per-user cooldowns
- A `/reload` command for hot-reloading a single command file without restarting the bot
- SQLite-backed persistence (`src/storage.ts`) for server and per-user settings
- A polling scheduler (`src/scheduler.ts`) that sends reminders when they're due
- Full CRUD management of server reminders, plus a server-wide master toggle
- Personal opt-in DM reminders, independent of any server setting
- A handful of utility commands (`/ping`, `/echo`, `/info`, `/server`, `/user`) used to shake out the framework

**Deferred / future enhancements (not blocking, not started):**
- Custom-styled Discord embeds for reminder messages (currently plain text, which still supports pasted image/GIF/YouTube/Spotify links via Discord's automatic link unfurling)
- True file/audio attachments on reminders (bundled sound files or user-uploaded audio)
- Global command registration, so `/remindme` can be run directly in a DM with the bot (currently guild-scoped only — see [Execution Model](#execution-model) note on command registration)
- Autocomplete for custom server emojis in reminder messages (Discord's own slash-command input fields don't always convert a picked custom emoji into its proper renderable format — this is a Discord client limitation, not a bug in this bot; standard Unicode emojis are unaffected)

## Tech Stack

- [discord.js](https://discord.js.org) v14
- TypeScript, executed natively by Node (no compile step in the normal run path — see [Execution Model](#execution-model))
- SQLite via `better-sqlite3` for persistence

## Execution Model

This project runs TypeScript **directly via Node's native type-stripping support** rather than compiling to a `dist/` folder first. This requires **Node.js v23.6.0 or later** (ideally the current LTS). There is a `build`/`dist` path available (`npm run build`) for future use (e.g. if deployment ever requires it), but it isn't part of the normal dev/run workflow.

Slash commands are currently registered **guild-scoped** (see `deploycommands` script below) for fast iteration during development. This means `/remindme` — despite delivering its reminders via DM — can currently only be *invoked* from within the configured test server, not from a direct DM with the bot. Switching to global command registration is a planned future step; see [Status](#status) above.

## Prerequisites

- Node.js v23.6.0+ (see [Execution Model](#execution-model) above)
- A Discord account and a registered application in the [Discord Developer Portal](https://discord.com/developers/applications)
- A bot token from that application

## Setup

1. **Clone and install dependencies**
   ```bash
   git clone <your-repo-url>
   cd shrimp-fried-this-rice
   npm install
   ```

2. **Configure environment variables**

   Create a `.env` file in the project root:
   ```env
   DISCORD_TOKEN=your-bot-token-here
   DISCORD_CLIENT_ID=your-application-client-id
   DISCORD_GUILD_ID=your-test-server-id
   ```
   > ⚠️ Never commit `.env` to version control. It's already listed in `.gitignore`.

3. **Invite the bot to your server**

   Use the OAuth2 URL Generator in the Developer Portal with the `bot` and `applications.commands` scopes, and permissions to send messages.

4. **Register slash commands**
   ```bash
   npm run deploycommands
   ```
   (Registers guild-scoped commands, using `DISCORD_GUILD_ID` — near-instant propagation, good for development. Re-run this any time a command's options/subcommands change.)

5. **Run the bot**
   ```bash
   npm run dev      # development, auto-restarts on file changes
   npm start        # runs the bot once, no auto-restart
   ```

   On first run, `reminders.db` (a SQLite file) is created automatically in the project root — no manual database setup needed.

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
| `/reminder list` | Lists the server's master toggle state, followed by every configured reminder and its status. |
| `/reminder toggle <label> <enabled>` | Enables or disables a specific reminder. |
| `/reminder delete <label>` | Deletes a reminder. |
| `/reminder master <enabled>` | Server-wide kill switch — overrides all individual reminders when off. Requires **Manage Server** permission; guild-only. |
| `/remindme [enabled] [interval] [message]` | Views (if called with no options) or updates your personal DM reminder settings. |
| `/remindme reset:true` | Deletes your personal DM reminder settings entirely. |

## Project Structure

```
src/
  index.ts              # client setup, command/event loading, login
  deploy-commands.ts    # registers slash commands with Discord's API
  scheduler.ts          # polling loop — checks storage.ts for due reminders and sends them
  storage.ts            # SQLite data-access layer (guild settings, guild reminders, user settings)
  types/
    command.ts           # shared Command interface
    types.d.ts            # module augmentation (adds `commands`/`cooldowns` to discord.js's Client)
  commands/
    utility/              # ping, echo, info, server, user, reload
    reminderCore/          # reminder (guildreminder.ts), remindme
  events/
    ready.ts               # ClientReady handler — also starts the scheduler
    interactionCreate.ts   # routes slash command interactions, handles cooldowns + errors
```

## Available Scripts

| Script | Purpose |
|---|---|
| `npm start` | Runs the bot once via native Node TypeScript execution |
| `npm run dev` | Runs the bot with `--watch`, auto-restarting on file changes |
| `npm run build` | Compiles to `dist/` via `tsc` (not part of the normal run path currently) |
| `npm run typecheck` | Type-checks the project without emitting output |
| `npm run deploycommands` | Registers slash commands with Discord's API |
| `npm run zip` | Bundles the project (excluding `node_modules`, `dist`, `.env`, `reminders.db`, etc.) into a shareable zip |

## Deployment

This bot needs to run as a long-lived process (not serverless), since the scheduler relies on an in-process polling loop. Suitable hosts include:
- [Railway](https://railway.app)
- [Fly.io](https://fly.io)
- A small VPS (DigitalOcean, Linode, etc.)

Any host used for production needs to provide Node.js v23.6.0+, per the [Execution Model](#execution-model) above.

> ⚠️ **Important — not yet set up:** many hosting platforms use an *ephemeral* filesystem by default, meaning `reminders.db` would be wiped on every redeploy/restart unless persistent storage (e.g. a Railway Volume or Fly.io Volume) is explicitly provisioned and the database path is pointed at it. This must be configured correctly **before** deploying anywhere beyond local development, or all configured reminders will be silently lost on the first redeploy.

## Roadmap

- [ ] Set up persistent, non-ephemeral storage for `reminders.db` on the chosen host, before deploying
- [ ] Switch to global command registration so `/remindme` works via direct DM
- [ ] Custom-styled embeds for reminder messages
- [ ] True file/audio attachment support (bundled sound files, or user-uploaded)
- [ ] Autocomplete for custom server emojis in reminder messages
- [ ] Snooze/pause command
- [ ] Web dashboard for configuration (longer-term idea)

## License

MIT