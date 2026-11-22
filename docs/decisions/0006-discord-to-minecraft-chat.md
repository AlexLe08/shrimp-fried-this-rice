# 0006: Discord to Minecraft chat: the helper reads with its own Discord app and writes over RCON

Status: Accepted · 2026-11-21

## Context

[0005](0005-minecraft-bridge-webhook-helper.md) made `mcbridge` a helper
beside the Minecraft server that posts to Discord through webhooks, and
listed "one-way only" among its consequences: Discord to Minecraft chat
would need a separate design. The owner asked for that direction on
2026-11-21 (design in [A8](../plans/minecraft-ff14-features.md#discord-to-minecraft-chat-a8-designed-2026-11-21)).

Constraints carried over from 0005: the bot's token never leaves the VM,
and no two processes share a token (README, `CASESTUDY.md` §2); the VM
opens no inbound port; the helper works with any launcher, panel or
container, on Windows, macOS and Linux; no runtime dependencies; free
tiers only.

What was checked against the docs on 2026-11-21:

- A webhook can't read a channel. Reading needs an app token, and the
  Message Content intent, without which `content` comes back empty
  "across the APIs" (REST included). REST calls need no gateway
  connection.
- A vanilla server has no input other than its console and RCON. RCON
  is not encrypted, and the server has no setting that binds it to
  localhost alone.

Options for reading Discord: the helper polling REST with its own Discord
application; the production bot forwarding messages, which needs an
inbound port on either the VM or the owner's home network; the helper on
the gateway with its own app (instant, but much more code without a
library); the bot's token on the host (ruled out). Options for writing
into the game: RCON with `tellraw`; the server's stdin, which needs
`mcbridge` to start the server; a plugin, of which there is none for
vanilla.

## Decision

`mcbridge` optionally reads the chat webhook's channel by polling
Discord's REST API every 2 s with a token from its own Discord
application (not the bot's), and sends each message into the game as
`tellraw @a` over RCON on the Minecraft host.

**Why:** TODO(Alex)

## Consequences

- The bot and the VM don't change, and the production token stays on
  the VM. Each Minecraft host's owner creates one more Discord
  application, switches on its Message Content intent, and gives it only
  View Channel and Read Message History in the bridge's channel.
- The config now holds secrets (an app token and the RCON password), so
  the setup guide asks for it to be readable only by its user. A leaked
  token lets someone read that one channel; Reset Token revokes it.
- RCON must not be reachable from outside the host (never forwarded on
  the router; in Docker, published on `127.0.0.1` only). The plain-text
  password makes this a setup step to get right, not one the helper can
  enforce.
- Messages take up to about 2 s to show in game. Messages sent while the
  server is down are dropped, not queued. If polling ever hits rate
  limits, a gateway connection replaces it, and this record is revisited.
- The helper still links no Discord account to a Minecraft player: names
  cross as text. Posting in the bridge's channel is a Discord user's
  opt-in to being shown in game, which the channel's topic should say.
  That opts in everyone already posting in an existing bridge channel the
  moment its host switches this on, which sits uneasily with 0005's opt-in
  default; a separate channel, or an announcement first, are the open
  alternatives (plan, A8).
- Without the new config key, nothing changes: the bridge stays one-way.
