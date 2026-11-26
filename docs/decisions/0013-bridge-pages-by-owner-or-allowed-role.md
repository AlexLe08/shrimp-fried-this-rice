# 0013: A server's Minecraft pages are for its owner and the role they allow, each route checking its own right

Status: Accepted · 2026-11-25; superseded in part by [0014](0014-any-member-reaches-their-own-minecraft-accounts.md) (the guard admits any member, for My Minecraft accounts)

## Context

[0012](0012-dashboard-checks-server-access-itself.md) has the dashboard
fetch the member from Discord and admit them to a server's pages when
they have Manage Server and aren't in timeout. One guard on every
`/servers/:guildId` route applied it (#71), and the server list showed
only those servers.

The plan's A8 ("In the dashboard", "Who counts") settled who manages a
server's Minecraft bridges: its owner, or members holding a role the
owner allows, not Manage Server ("That follows the owner's rule rather
than Track D's Manage Server default"). Pairing already checks this
(`canManageBridges` in `src/minecraft/pairing.ts`, #80), and A8d's
storage keeps the allowed role per server (#77). A8f puts those pages in
the dashboard, so a member with the role but without Manage Server has to
reach them, and a member with Manage Server only must not.

Options, weighed on 2026-11-25 (A8f's first part):

| Option | Cost |
|---|---|
| **One guard on `/servers/:guildId/*` admitting either right, then each route checking the right it needs** | A route that forgot its check would serve anyone with the other right; a test tries every server route as a user holding only the other one |
| A second guard on another prefix for the Minecraft pages | One server's pages split across two URL trees, against CLAUDE.md's "a page about one server goes under `/servers/:guildId`"; the helper's `/minecraft/` prefix is taken, and skips the pages' rate limit |
| Manage Server for the Minecraft pages too | Goes against the plan's settled rule; a member with only the allowed role couldn't pair from the dashboard, though pairing allows them |

## Decision

A server's Minecraft pages are for its owner and members with the
allowed role, not in timeout, from the same fresh member fetch as 0012,
which still decides every other server page. The guard on
`/servers/:guildId/*` admits a member with either right, and each route
then requires its own: `ROUTE_ACCESS` lists it as `server` (Manage
Server) or `bridges` (owner or allowed role). The server list shows a
server where the user has either, linking the pages that are theirs.

**Why:** TODO(Alex)

## Consequences

- No extra Discord call: the fetch that answers Manage Server returns the
  member's roles too, and both rights share its 30-second cache.
- Deny by default now rests on two checks rather than one. A test tries
  every `server` and `bridges` route as a user with only the other right,
  so a route added without its check fails it; a third right (A8f's My
  Minecraft accounts, for any member) adds a level and the same test.
- A role made the allowed one, or taken from a member, applies within 30
  seconds, like a lost Manage Server. Pages that change bridges (A8f's
  later parts) check with Discord fresh, as 0012 asks of any change.
- The server's owner is read from the bot's cache (`guild.ownerId`), kept
  current by the `Guilds` intent, as pairing already does.
- The server list may now name servers where the user lacks Manage
  Server. They're members there with a right the owner gave, so this
  tells them nothing they couldn't see in Discord.
- The Minecraft page names a bridge's channels from the bot's cache, so
  a role holder who can't see a private chat or alerts channel in
  Discord still learns its name and ID, as a Manage Server user does
  from the reminders page. Bridge channels are normally ones the players
  see; pairing checks the member can see each channel it's given.
