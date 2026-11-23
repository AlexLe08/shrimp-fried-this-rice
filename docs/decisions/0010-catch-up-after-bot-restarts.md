# 0010: The bot catches up on bridge chat it missed while restarting

Status: Proposed · 2026-11-23

## Context

[0006](0006-discord-to-minecraft-chat.md) routes Discord to Minecraft
chat through the bot, and accepted as a consequence that while the VM is
down or restarting for a deploy, messages sent in Discord aren't
relayed: the bot receives nothing over the gateway then, and Discord
doesn't replay what it missed. The plan's A8 listed the same cost ("two-way
chat pauses").

Reviewing the decisions' consequences for serious ones (2026-11-23,
with the owner) found this one larger than it looked: every merge to
`main` restarts the bot, so each deploy silently loses whatever players
posted in bridge channels during those seconds, with no sign to anyone
that it happened. Discord's API still serves a channel's recent messages
over REST, which the gateway doesn't replay.

## Decision

When the bot is ready again, it catches up each paired bridge's chat
channel from Discord's API: messages after the last one it relayed and
before the first one the gateway has delivered since, at most 5 minutes
old and at most 20, relayed in order at the normal rate, before any new
ones. Anything older or beyond that is dropped, as before. The design's
details are in the plan's [A8](../plans/minecraft-ff14-features.md#discord-to-minecraft-chat-a8).

**Why:** TODO(Alex)

## Consequences

- A deploy no longer loses bridge chat; a longer outage loses only what's
  older than 5 minutes or past the first 20.
- The bot needs Read Message History in each bridge's chat channel,
  checked when a bridge's channels are picked, like its other
  permissions.
- `bot.db` keeps the id of each bridge's last relayed message (an id, not
  its text, so 0006's "chat is never stored" holds), updated as messages
  are relayed.
- Caught-up messages wait for the helper, which may still be backing off
  from the restart: they're held until its first poll after the bot is
  ready, for up to 2 minutes (its backoff tops out at 60 s), instead of
  the usual 30 s.
- The bot can't know whether the Minecraft server was up while it was
  away, so caught-up messages are dropped if the server is down when the
  catch-up runs, as live ones are.
- When this record is accepted, 0006's status becomes "superseded in part
  by [0010](0010-catch-up-after-bot-restarts.md) (chat missed while the
  bot restarts is caught up)", in the index too.
