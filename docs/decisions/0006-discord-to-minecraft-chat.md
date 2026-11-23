# 0006: Discord to Minecraft chat goes through the bot, set up in the dashboard

Status: Accepted · 2026-11-22; superseded in part by [0008](0008-dashboard-hostname-and-https.md) (reached through a Cloudflare Tunnel with no inbound port; the helper's traffic is encrypted end to end across it)

## Context

[0005](0005-minecraft-bridge-webhook-helper.md) made `mcbridge` a helper
beside the Minecraft server that posts to Discord through webhooks, and
listed "one-way only" among its consequences: Discord to Minecraft chat
would need a separate design. It also turned down a bot-side endpoint,
for the inbound port, TLS and lost events it would cost. The owner asked
for the other direction on 2026-11-21, along with players choosing their
picture from Discord ([0007](0007-players-choose-their-picture-from-discord.md)).
Design: [A8](../plans/minecraft-ff14-features.md#discord-to-minecraft-chat-a8).

A webhook can't read a channel, and the Minecraft host sits behind a home
router. A vanilla server takes input only from its console and from RCON,
which is not encrypted.

The first design (in PR #53's history) gave the helper its own Discord
application on the gateway: no change to the VM, and chat never passing
through it, as DiscordSRV does. It left each server owner creating an app
in the Developer Portal, and the helper with a hand-written gateway
client. Moving most of the setup into Discord helped, but not with that
first step. The owner wants a server owner to have as little to set up
as possible beyond the bot, and accepted two-way chat being set up only
in the dashboard ([Track D](../plans/minecraft-ff14-features.md#track-d-web-dashboard)).
The dashboard already needs what 0005 turned down: a public HTTPS
endpoint on the VM.

Discord's privileged intent review (checked 2026-11-22): an app that more
than 10,000 users can see, across all its servers, must apply for
Message Content and be reviewed yearly; below that it's switched on in
the Developer Portal. The owner isn't publishing the bot widely.

## Decision

Two-way chat goes through the production bot. In the dashboard, a server
owner adds a Minecraft server. The bot makes the bridge's webhooks and a
secret, and hands over a config. The helper connects out to the bot's
HTTPS endpoint with that secret. The bot reads the bridge's channel and
sends messages to the helper, which runs `tellraw @a` over RCON. Settings,
links and pictures live in `bot.db`. Two-way chat waits for the
dashboard's hostname, HTTPS and login (D0, D1).

**Why:**

A dashboard was already part of the plan, just moved up now when considering the many benefits it will provide early on for this bridge. Discord is ultimately a chatting application so often times there's friction in the user experience when trying to perform website like functionality, so a dashboard should help reduce that friction. The bot handling secret values is ideal to ensure inexperienced users don't set up values incorrectly or worse, reveal it in public space unintentionally. A dashboard experience also removes the Developer Portal Step, so much of the experience is dependent on me to shape.

## Consequences

- A server owner's setup is the dashboard plus, on the host, the
  downloaded config with `logPath` filled in and RCON switched on. No
  Developer Portal, no second app, no Discord token on the host.
- The helper has no Discord protocol in it. The VM gains its first
  inbound endpoint, shared with the dashboard, and the bot gains the
  `GuildMessages` and Message Content intents. With them it receives
  every message in every server it's in, and reads only bridge channels.
- Other servers' chat passes through the VM, in memory only: never
  stored or logged. Links and settings are kept in `bot.db`, and deleted
  when the bot leaves a server.
- The VM is the hub: while it's down or restarting for a deploy,
  messages sent in Discord aren't relayed (the bot doesn't receive them,
  and Discord doesn't replay them). A 30 s hold covers only the helper
  reconnecting. Minecraft to Discord keeps working, as it still posts
  through webhooks from the host.
- Messages sent while the Minecraft server is down are dropped, and the
  stop message says so. The relay is announced in the channel before it
  starts.
- RCON must not be reachable from outside the host: never forwarded on
  the router, and in Docker published on `127.0.0.1` only.
- Two-way chat waits for Track D's foundation. One-way chat doesn't
  change, and the parts that don't depend on the bot (the RCON client,
  the `tellraw` builder, the `server.properties` reader, the `!link`
  line) can be built before it.
- If the bot were published widely and passed 10,000 users, Message
  Content would need Discord's review. A refusal would stop every
  bridge. The way out then would be a separate app just for the bridge,
  or the per-host design. That would mean revisiting this record.
