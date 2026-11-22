# 0007: Players in the Discord server choose their picture in the dashboard, after linking their account in game

Status: Accepted · 2026-11-22

## Context

Since #51 each Minecraft player's chat lines in Discord carry a picture,
chosen by whoever runs the Minecraft server in `mcbridge`'s config
(`avatars`): a bundled picture by default, the player's skin only for
players listed as opting in. The plan's next step was players choosing in
game (`!avatar skin` in chat). On 2026-11-21 the owner changed that: a
player who is in the Discord server chooses from Discord, since the
picture is shown with their name there; anyone else keeps the server's
default.

[0005](0005-minecraft-bridge-webhook-helper.md)'s Why includes not tying
Minecraft players directly to their Discord accounts. Choosing from
Discord needs exactly that tie: a display name proves nothing, as anyone
can set their nickname to a player's name.

[0006](0006-discord-to-minecraft-chat.md) routes two-way chat through the
bot and the dashboard, so a member can be identified there through
Discord login. The helper reads in-game chat, whose sender is trustworthy
because chat matching is anchored, and the UUID each player logs in with.

## Decision

A Discord member links their account to a Minecraft name in the
dashboard, which gives them a one-time code, and proves it by typing
`!link <code>` in game as that player. The link is to the player's
account (a Mojang UUID seen that session, on an online-mode server), not
just the name. Once linked, they choose their picture in the dashboard:
their Discord picture, their skin, a bundled picture, or the server's
default. The choice applies while they're in the Discord server and log
in with the linked UUID; otherwise, and for players who never link, the
server's `avatars` setting decides as before. Links are kept in `bot.db`.

**Why:**

Early decisions were made with assumptions tying accounts together would have many requirements that return more info than necessary, but after weighing the potential that comes from having a dashboard site, I chose to have the dashboard be central in this feature's functionality and user experience. Players still choose whether they wish to perform the link or not, and without it can still reap the functionality of the bridge channel without making links. Their identity ties can only be inferred without linking if their Discord name and Minecraft names are the same, which is an acceptable scope for a bot designed for friend servers at this time. If this bot were to scale up further for more larger server use, then we can come back to refining the process.

## Consequences

- This narrows 0005's "not tying players to Discord accounts" to "never
  without the player doing it from both sides". Only the player can create
  a link, and unlinking, or the bot leaving the server, deletes it.
- Links live on the VM, not the Minecraft host, as the bot checks the
  code and serves the pictures. The helper's settings cache leaves linked
  players' pictures out, so while the bot is down they get the server's
  default.
- In-game `!avatar` is dropped. The `avatars` setting (from the config,
  or from the dashboard by the Discord server's owner or allowed role)
  stays as the default for everyone.
- An offline-mode server, where anyone can join under any name, can't
  link. A name that changes hands doesn't carry the picture with it.
- There's no picture-link option in the dashboard. A member who wants a
  custom picture sets it as their Discord picture, which Discord has
  already accepted for them.
- Linking needs two-way chat, so it also waits for the dashboard's
  foundation.
- `/minecraft link` and `/minecraft avatar` offer linking and the same
  picture choice in Discord, for when the dashboard can't be reached
  while the bot is up (the owner's calls, 2026-11-22).
