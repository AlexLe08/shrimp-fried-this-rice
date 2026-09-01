# Posture & Hydration Reminder Bot

A Discord bot built with **TypeScript** and **discord.js v14**. The end goal is a bot that periodically sends a preset reminder message (e.g. "Check your posture!" or "Time to drink water!") to a server channel, and optionally as a DM to individual users who opt in.

> **Status:** the bot's core framework (command handling, event handling, cooldowns, error handling) is built and working. The reminder-scheduling feature itself (the original goal of the project) has not been implemented yet — see [Status](#status) below for the current breakdown.

## Status

**Built and working:**
- Slash command loading and registration
- Event handling (`ClientReady`, `InteractionCreate`)
- Per-command, per-user cooldowns
- A `/reload` command for hot-reloading a single command file without restarting the bot
- A handful of utility commands (`/ping`, `/echo`, `/info`, `/server`, `/user`) used to shake out the framework

**Not yet implemented (stubbed files exist, logic doesn't yet):**
- `src/scheduler.ts` — will hold the interval/cron logic that actually sends the periodic reminder
- `src/storage.ts` — will hold the persistence layer (per-user/per-server settings: interval, custom message, DM toggle)
- The reminder message itself, and the commands to configure it (interval, target channel, DM opt-in)

## Tech Stack

- [discord.js](https://discord.js.org) v14
- TypeScript, executed natively by Node (no compile step in the normal run path — see [Execution Model](#execution-model))
- `node-cron` (installed, not yet wired up) for scheduling
- Persistence layer not yet chosen/implemented

## Execution Model

This project runs TypeScript **directly via Node's native type-stripping support** rather than compiling to a `dist/` folder first. This requires **Node.js v23.6.0 or later** (ideally the current LTS). There is a `build`/`dist` path available (`npm run build`) for future use (e.g. if deployment ever requires it), but it isn't part of the normal dev/run workflow.

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
   (Registers guild-scoped commands, using `DISCORD_GUILD_ID` — near-instant propagation, good for development.)

5. **Run the bot**
   ```bash
   npm run dev      # development, auto-restarts on file changes
   npm start        # runs the bot once, no auto-restart
   ```

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

*(Reminder-related commands — setting interval, target channel, custom message, DM toggle — are planned but not yet implemented.)*

## Project Structure

```
src/
  index.ts              # client setup, command/event loading, login
  deploy-commands.ts    # registers slash commands with Discord's API
  scheduler.ts          # [stub] will hold reminder scheduling logic
  storage.ts            # [stub] will hold settings persistence
  types/
    command.ts           # shared Command interface
    types.d.ts            # module augmentation (adds `commands`/`cooldowns` to discord.js's Client)
  commands/
    utility/              # current command files (ping, echo, info, server, user, reload)
  events/
    ready.ts               # ClientReady handler
    interactionCreate.ts   # routes slash command interactions, handles cooldowns + errors
```

## Available Scripts

| Script | Purpose |
|---|---|
| `npm start` | Runs the bot once via native Node TypeScript execution |
| `npm run dev` | Runs the bot with `--watch`, auto-restarting on file changes |
| `npm run build` | Compiles to `dist/` via `tsc` (not part of the normal run path currently) |
| `npm run typecheck` | Type-checks the project without emitting output |
| `npm run deploycommands` |	Registers slash commands with Discord's API |
| `npm run zip` | Bundles the project (excluding `node_modules`, `dist`, `.env`, etc.) into a shareable zip |

## Deployment

This bot needs to run as a long-lived process (not serverless), since it relies on in-memory or scheduled intervals once the scheduler is built. Suitable hosts include:
- [Railway](https://railway.app)
- [Fly.io](https://fly.io)
- A small VPS (DigitalOcean, Linode, etc.)

Any host used for production needs to provide Node.js v23.6.0+, per the [Execution Model](#execution-model) above.

## Roadmap

- [ ] Build `storage.ts` — persistence layer for per-user/per-server settings
- [ ] Build `scheduler.ts` — interval/cron logic to actually send reminders
- [ ] Commands to configure the reminder: interval, target channel, message text, DM toggle
- [ ] Per-server custom messages and intervals
- [ ] Snooze/pause command
- [ ] Multiple reminder types (posture, water, eyes, stretching) on independent schedules

## License

MIT