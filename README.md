# Posture & Hydration Reminder Bot

A Discord bot built with **TypeScript** and **discord.js v14** that periodically sends a preset reminder message (e.g. "Check your posture!" or "Time to drink water!") to a server channel, and optionally as a DM to individual users who opt in.

## Features

- ⏱️ Configurable interval — set reminders to repeat every X hours or minutes
- 📢 Channel broadcasts — post the reminder into a chosen server channel
- 💬 Per-user DMs — users can toggle personal DM reminders on/off
- ✏️ Custom message — the reminder text is configurable, not hardcoded
- 💾 Persistent settings — configuration survives bot restarts

## Tech Stack

- [discord.js](https://discord.js.org) v14
- TypeScript
- `node-cron` or `setInterval` for scheduling
- SQLite (via `better-sqlite3` or `prisma`) for persistence

## Prerequisites

- Node.js 18+
- A Discord account and a registered application in the [Discord Developer Portal](https://discord.com/developers/applications)
- A bot token from that application

## Setup

1. **Clone and install dependencies**
   ```bash
   git clone <your-repo-url>
   cd posture-bot
   npm install
   ```

2. **Configure environment variables**

   Create a `.env` file in the project root:
   ```env
   DISCORD_TOKEN=your-bot-token-here
   CLIENT_ID=your-application-client-id
   GUILD_ID=your-test-server-id
   ```
   > ⚠️ Never commit `.env` to version control. Make sure it's listed in `.gitignore`.

3. **Invite the bot to your server**

   Use the OAuth2 URL Generator in the Developer Portal with the `bot` and `applications.commands` scopes, and permissions to send messages.

4. **Register slash commands**
   ```bash
   npm run register-commands
   ```

5. **Run the bot**
   ```bash
   npm run dev      # development, with auto-reload
   npm run build && npm start   # production
   ```

## Commands

| Command | Description |
|---|---|
| `/set-channel #channel` | Sets the channel where reminders are posted |
| `/set-interval hours:2` | Sets how often the reminder fires |
| `/set-message "text"` | Sets the custom reminder text |
| `/dm-toggle on\|off` | Enables/disables personal DM reminders for the user running the command |

## Project Structure

```
src/
  index.ts        # client setup and login
  scheduler.ts    # interval/cron logic for sending reminders
  storage.ts      # persistence layer (SQLite)
  commands/       # slash command definitions and handlers
```

## Deployment

This bot needs to run as a long-lived process (not serverless), since it relies on in-memory or scheduled intervals. Suitable hosts include:
- [Railway](https://railway.app)
- [Fly.io](https://fly.io)
- A small VPS (DigitalOcean, Linode, etc.)

## Roadmap / Ideas

- [ ] Per-server custom messages and intervals
- [ ] Snooze/pause command
- [ ] Multiple reminder types (posture, water, eyes, stretching) on independent schedules
- [ ] Web dashboard for configuration

## License

MIT
