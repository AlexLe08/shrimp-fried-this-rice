# 0012: The dashboard asks Discord which servers a user may manage, through the bot

Status: Accepted · 2026-11-24

## Context

The dashboard's server list and every page about one server need to know
which servers a signed-in user may manage. Track D's plan and
[0009](0009-dashboard-on-hono.md)'s Context listed the OAuth2 scopes
`identify` and `guilds` for D1, which would have given the dashboard the
user's servers and permissions from Discord at login. 0009's Decision
doesn't name the scopes, so this record settles the question rather than
superseding it.

Login (#69) asks for `identify` only and revokes Discord's token straight
after reading who the user is; sessions last 7 days (#68). The bot has
the `Guilds` and `GuildExpressions` intents, not the privileged Server
Members intent, so it isn't told when a member's roles change, and a
member in its cache can keep a permission they've lost. The roles
themselves stay current through `Guilds`. Without that intent, the bot can
still ask Discord about one member of a server it's in
(`GET /guilds/{id}/members/{user}`, discord.js's `members.fetch`). The
owner isn't publishing the bot widely: it's in a few servers.

Options, weighed on 2026-11-24:

| Option | Freshness | Discord calls | Other costs |
|---|---|---|---|
| **The bot asks Discord, per server, per user** | Current on each check | One per server the bot is in, for the list; one for a server's page | Calls share discord.js's request queue with reminder sends and command replies |
| The `guilds` scope at login, the list kept in the session | As at login, for up to 7 days | One at login | Keeping the user's token, or the list in `bot.db`; a per-server page still needs a current check for decision 0009's deny-by-default guard, so it adds a second source |

## Decision

The bot checks for itself. For each server it's in, it fetches the member
from Discord (not its cache), and the user may manage a server when they
have Manage Server there and aren't in timeout. The same check backs the
server list and the guard on every `/servers/:guildId` route. Login stays
`identify` only.

**Why:**

Responsive and accurate. Will look into the alternative methods if this bot were to grow in scale and use.

## Consequences

- Permissions are current: losing Manage Server, being removed from a
  server or being put in timeout applies within 30 seconds, not when the
  session ends.
- One source of truth for both the list and the guard, both built from
  `dashboard/access.ts` (#71).
- Login asks Discord for nothing beyond who the user is, and the
  dashboard keeps no Discord token.
- Each check is a Discord call in the request queue that reminder sends
  and command replies share, and any signed-in visitor can cause them.
  So each answer is reused for 30 seconds, and a check under way is
  shared (#71, from review). The cache is per user, so one person
  reloading costs nothing more, but each new Discord account that logs
  in adds one call per server every 30 seconds: the rate limit still to
  come in D1 counts per signed-in user as well as per visitor. Unknown Member (404) doesn't count towards
  Discord's limit on refused requests (401, 403 and 429; its rate limit
  docs, read 2026-11-24).
- A lost permission takes up to 30 seconds to apply. Harmless while the
  pages only show; once D2 lets them change things, a change checks
  access fresh, skipping the cache.
- The server list costs one call per server the bot is in. That's fine
  for a few servers, and would need revisiting if the bot were in many:
  the `guilds` scope, or the Server Members intent with a kept cache.
- discord.js's `permissions` ignore a timeout, so the check asks for it
  separately. A server's own command permission overrides (Server
  Settings → Integrations) aren't consulted: Manage Server decides. That
  is unlikely to be a privilege gain (someone with Manage Server can
  likely change those overrides; from memory, not checked against
  Discord's docs), but moderators given `/reminder` without Manage Server
  can't use the dashboard. Whether to follow the overrides instead is
  decided before D2.
- Any failure counts as no access, a Discord outage included, so a
  manager sees "Not found" for their own server while Discord is down.
