# 0007: Players in the Discord server choose their picture there, after linking their account in game

Status: Accepted · 2026-11-21

## Context

Since #51 each Minecraft player's chat lines in Discord carry a picture,
chosen by whoever runs the Minecraft server in `mcbridge`'s config
(`avatars`): a bundled picture by default, the player's skin only for
players listed as opting in. The plan's next step was players choosing in
game (`!avatar skin` in chat). On 2026-11-21 the owner changed that: a
player who is in the Discord server chooses from Discord, since the
picture is shown with their name there; anyone else keeps the server's
default (the `avatars` setting, which can now also be set from Discord).

[0005](0005-minecraft-bridge-webhook-helper.md)'s Why includes not tying
Minecraft players directly to their Discord accounts. Choosing from
Discord needs exactly that tie: a display name proves nothing, as anyone
can set their nickname to a player's name.

[0006](0006-discord-to-minecraft-chat.md) gives the helper its own
Discord app on the gateway, so it can take slash commands with private
replies. The helper also reads in-game chat, whose sender is trustworthy
because chat matching is anchored.

## Decision

A Discord member links their account to a Minecraft name by running
`/mcbridge link`, which gives them a one-time code privately, and typing
`!link <code>` in game as that player. The link is to the player's
account (its UUID), not just the name. Once linked, they choose their
picture with `/mcbridge avatar` (their Discord picture, their skin, a
bundled picture, or the server's default). The choice applies while
they're in the Discord server; otherwise, and for players who never
link, the server's `avatars` setting decides as before. Links live only in the helper's state
file on the Minecraft host.

**Why:** TODO(Alex)

## Consequences

- This narrows 0005's "not tying players to Discord accounts" to "never
  without the player doing it from both sides". Only the player can create
  a link, `unlink` removes it, and it never leaves the Minecraft host.
- In-game `!avatar` is dropped. The `avatars` setting (from the config,
  or from `/mcbridge` by the Discord server's owner or allowed role)
  stays as the default for everyone, and the server's own per-player choices still
  apply to players who don't link.
- Linking needs a Mojang (version 4) UUID logged that run, so an
  offline-mode server, where anyone can join under any name, can't link.
  A choice applies only while the player logs in with the linked UUID, so
  a name that changes hands doesn't carry the picture with it.
- There's no URL option: a member who wants a custom picture sets it as
  their Discord picture, which Discord has already accepted for them.
- A `discord` picture is a CDN URL with a hash that changes when they
  change their picture. The helper refreshes it whenever it sees them,
  and until then Discord may show its default picture.
- Linking needs both the Discord side (0006) and the in-game chat line,
  so it's available only where the two-way bridge is configured.
