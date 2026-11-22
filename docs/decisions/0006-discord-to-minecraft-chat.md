# 0006: Discord to Minecraft chat: the helper connects with its own Discord app and writes over RCON

Status: Accepted · 2026-11-21

## Context

[0005](0005-minecraft-bridge-webhook-helper.md) made `mcbridge` a helper
beside the Minecraft server that posts to Discord through webhooks, and
listed "one-way only" among its consequences: Discord to Minecraft chat
would need a separate design. The owner asked for that direction on
2026-11-21, along with players choosing their picture from Discord
([0007](0007-players-choose-their-picture-from-discord.md)). Design:
[A8](../plans/minecraft-ff14-features.md#discord-to-minecraft-chat-a8-designed-2026-11-21).

Constraints carried over from 0005: the bot's token never leaves the VM,
and no two processes share a token (README, `CASESTUDY.md` §2); nothing
opens an inbound port, on the VM or on the Minecraft host's network; the
helper works with any launcher, panel or container, on Windows, macOS and
Linux; no runtime dependencies; free tiers only.

What was checked against the docs on 2026-11-21:

- A webhook can't read a channel or receive commands. Reading needs an
  app token and the Message Content intent; slash commands need the app
  to receive interactions, over the gateway or at a public HTTP endpoint.
- A vanilla server takes input only from its console and from RCON. RCON
  is not encrypted, and the server has no setting that binds it to
  localhost alone.

Options for reaching Discord:

- The helper on the gateway, with its own app.
- The helper polling REST with its own app. This was the first draft,
  dropped when choosing pictures moved to Discord, as a poll can't
  receive slash commands.
- The production bot owning the commands and passing choices to the
  helper, which needs an inbound port or a channel used as a data store.
- The bot's token on the host, ruled out.

Options for writing into the game: RCON with `tellraw`; the server's
stdin, which needs `mcbridge` to start the server; a plugin, of which
there is none for vanilla.

## Decision

When configured, `mcbridge` connects to Discord's gateway with a token
from its own Discord application (not the bot's), relays messages from
the chat webhook's channel into the game as `tellraw @a` over RCON on the
Minecraft host, and registers its own `/mcbridge` command in that Discord
server. The gateway client is written by hand, with Node 24's built-in
`WebSocket`, rather than taking on a library.

**Why:** TODO(Alex)

## Consequences

- The bot and the VM don't change, and the production token stays on
  the VM. Each Minecraft host's owner creates one more Discord
  application, switches on its Message Content intent, and invites it
  with only View Channel and Read Message History in the bridge's
  channel.
- The helper now carries a hand-written gateway client: heartbeats,
  resume, and close codes. A restart loop must back off, as going over
  1,000 identifies a day resets the app's token. If this code becomes a
  burden, a library (a runtime dependency, the owner's call) is the way
  out.
- The config now holds secrets (an app token and the RCON password), so
  the setup guide asks for it to be readable only by its user. A leaked
  token lets someone read that one channel and answer `/mcbridge` as the
  app; Reset Token revokes it.
- RCON must not be reachable from outside the host: never forwarded on
  the router, and in Docker published on `127.0.0.1` only. With a
  plain-text password, this is a setup step to get right, not one the
  helper can enforce.
- Messages sent while the server is down are dropped, not queued, and
  the stop message says so.
- Posting in the bridge's channel is a Discord member's opt-in to being
  shown in game. The helper announces it once in the channel, and the
  setup guide asks for it to be announced ahead of time and said in the
  channel's topic.
- The prefix and its colour are set from Discord by the Discord server's
  owner or a role they allow, and kept in a state file the helper writes
  beside its config.
- Without the new config key, nothing changes: the bridge stays one-way.
