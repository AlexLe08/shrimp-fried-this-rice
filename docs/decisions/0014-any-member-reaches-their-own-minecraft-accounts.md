# 0014: Any member reaches their own Minecraft accounts page; the server guard admits any member

Status: Accepted · 2026-11-26

## Context

[0013](0013-bridge-pages-by-owner-or-allowed-role.md) has the guard on
`/servers/:guildId/*` admit a member with Manage Server or the right to
manage bridges, and each route then require its own right. Its
Consequences foresaw a third right: "A8f's My Minecraft accounts, for any
member, adds a level and the same test."

The plan's A8 ("In the dashboard") gives My Minecraft accounts to any
member: [0007](0007-players-choose-their-picture-from-discord.md) has
players in the Discord server link their own Minecraft name and choose
its picture there. Linking's first two parts (#96, the bot checking
`!link` reports; #97, the helper sending them) left nothing to give
members a code. A page about one server goes under `/servers/:guildId`
(CLAUDE.md), and the guard there turned away anyone without a right, so a
plain member couldn't reach one.

Options weighed:

- **A page outside `/servers/:guildId`** (say `/minecraft/accounts`,
  across every server): keeps the guard as it is, but needs its own
  membership check per server, and `/minecraft/` is the helper's route
  space.
- **A second guard for member routes only**: keeps the first guard's
  denial, at the cost of two guards under one prefix to keep in step.
- **Chosen: the one guard admits any member, and every route requires
  its own right, `member` needing nothing more.**

## Decision

The guard on `/servers/:guildId/*` admits any member of the server (the
same fetch, the same 404 for anyone else). Every route there names the
right it needs in `ROUTE_ACCESS` and with `requires`: `server`,
`bridges`, `owner`, or `member`, which needs nothing more.
`/servers/:guildId/minecraft/accounts` is a `member` page: the member's
own links, unlinking them, and link codes. The server list shows a server
where the user is only a member when it has a Minecraft server.

**Why:**

Dashboard access by default should be a path of least resistance when possible. This also helps open things up for any future features that could be accessible to regular members. So ideally the management related features that are typically reserved for roles that would usually be a small number of folks are what get treated like edge case behavior instead of default page behavior.

## Consequences

- Deny by default for a plain member now rests on each route's `requires`
  alone, not on the guard as well. The route-access test tries every
  `server`, `bridges` and `owner` route as a member with no right, so a
  route added without its check fails it, and tries every `member` route
  as that member.
- Members in timeout reach My Minecraft accounts, as it's about
  themselves; 0012's and 0013's rights still exclude them from managing.
- No extra Discord call: the guard's fetch is the one 0012 and 0013
  already make, with the same 30-second cache, and the pages that change
  something ask afresh (0012).
- The server list may name servers where the user has no right, only
  where they're a member and it has a Minecraft server: nothing they
  can't see in Discord.
- A fifth level would follow the same pattern: a `ROUTE_ACCESS` value, a
  `requires` case and the same test.
