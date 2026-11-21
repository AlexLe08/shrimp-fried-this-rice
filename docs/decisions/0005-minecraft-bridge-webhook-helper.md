# 0005: The Minecraft bridge is a separate helper that posts through a webhook

Status: Accepted · 2026-11-21

## Context

The owner wants a Minecraft server's start and stop, its chat, and its real
errors posted to Discord ([Track A](../plans/minecraft-ff14-features.md#track-a-minecraft-bridge)).
The bot runs on the Oracle Cloud VM; the Minecraft server runs on the
owner's own machine (today a vanilla 26.3 server in a Docker container), so
the bot cannot read the server's log. Something has to run beside the
server.

Constraints that shaped it:

- That something must not log in with the bot's token. Two processes on one
  token both receive every event: it happened once, with a local instance
  beside production, and doubled replies and reminders (README's warning,
  `CASESTUDY.md` §2).
- Minecraft hosts may run Windows, macOS or Linux, and servers may later be
  Paper, Fabric or Forge as well as vanilla.
- Free tiers only, and no new runtime dependency without the owner.

The options on the table were a helper posting to a Discord webhook; a
helper sending events to an HTTP endpoint on the bot (an inbound port opened
in Oracle's security list and the VM's firewall, TLS or a shared secret, and
events lost while the bot restarts); the helper logging in with the bot
token (ruled out above); and an existing plugin such as DiscordSRV (none for
a vanilla server).

## Decision

`mcbridge` is a standalone Node script in this repository, under
`src/minecraft/bridge/`, with no runtime dependencies. It reads the server's
`logs/latest.log` by polling and posts to Discord through webhook URLs kept
in a git-ignored config file on the Minecraft host. The bot never loads it.

**Why:** TODO(Alex)

## Consequences

- No bot token leaves the VM and the VM opens no port. A leaked webhook URL
  lets someone post in one channel, not act as the bot; deleting the webhook
  in Server Settings revokes it.
- Messages come from the webhook, not the bot user. Each chat line can carry
  the player's name as its sender, which the bot user couldn't.
- Reading the log rather than wrapping the server process works with any
  launcher, script, hosting panel or container, as long as the helper can
  read the log file (for a container, the host side of its data volume).
- The bot knows nothing of the Minecraft server's state. A feature that
  needs that (a `/minecraft status` that knows who is online) would use a
  Server List Ping or a bot-side endpoint, and revisit this record.
- One-way only: Discord to Minecraft chat would need RCON, a separate design.
- The code deploys to the VM with every merge and sits there unused, and it
  is linted, type-checked and tested with the rest.
- The helper only sees what the log records: output the container or launcher
  prints before the server starts (JVM warnings, an image's `[init]` lines)
  isn't in `latest.log`.
