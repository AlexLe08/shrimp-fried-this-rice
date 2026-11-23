# 0009: The dashboard runs in the bot on `node:http`, with no web framework

Status: Proposed · 2026-11-23

## Context

The dashboard needs a web server for its pages, Discord login, and the
helper's endpoint ([0006](0006-discord-to-minecraft-chat.md)). Track D's
plan leaned towards running it inside the bot process, which shares the
one database connection ([0004](0004-feature-storage-modules.md)) and the
live Discord client (channel lists, the reminder status embed, the
bridge's channel). A second process would need its own way to reach
both. Caddy sits in front ([0008](0008-dashboard-hostname-and-https.md)),
so the server speaks plain HTTP on `127.0.0.1`.

What D1 needs: Discord OAuth2 (`identify`, `guilds`), sessions,
protection against cross-site requests, rate limiting, HTML escaping,
and a handful of read-only pages rendered on the server. A8 adds one
endpoint the helper long-polls, and left its transport to D0:
long-polling on `node:http`, or a WebSocket through the `ws` package.

Constraints: Node runs `src/` by type stripping, with no build, so no
JSX (CLAUDE.md). A runtime dependency is the owner's decision. `mcbridge`
is deliberately dependency-free ([0005](0005-minecraft-bridge-webhook-helper.md)).

Options (versions checked 2026-11-23):

| Option | Runtime dependencies | What it brings | What it costs |
|---|---|---|---|
| **`node:http`, `fetch` and `node:crypto` (Node 24 built-ins)** | None | Nothing to update or audit. Long-polling is a held response. | We write and test the routing, the cookie and form parsing, the HTML escaping, the cross-site check and the rate limiter ourselves: small, but security-relevant. |
| Hono 4 with `@hono/node-server` 2 | Two packages, neither with dependencies of its own; Node 20 or later | Routing, signed cookies (HMAC SHA-256), a CSRF middleware (checks `Origin` or `Sec-Fetch-Site` on form posts), an `html` template helper | Its JSX needs `.tsx` and a JSX transform, which type stripping doesn't do, so only the `html` helper is usable. Two packages to keep updated. |
| Fastify or Express | Many, transitively, plus plugins for cookies, CSRF and rate limits | The most documentation and examples | Far more than a few pages need; the most to keep updated. |

## Decision

The dashboard and the helper's endpoint run in the bot process, on
Node's `node:http`, listening on `127.0.0.1` behind Caddy. No web
framework: OAuth2 uses `fetch`, sessions and secrets use `node:crypto`,
and pages are server-rendered strings through one escaping helper. The
helper talks to the bot by long-polling, so `ws` isn't added.

**Why:** TODO(Alex)

## Consequences

- No new runtime dependency, and nothing new in `package.json` for the
  deploy's `npm ci`.
- The security-relevant pieces are ours and need their own tests: HTML
  escaping, session cookies (`HttpOnly`, `Secure`, `SameSite=Lax`, a
  random id or an HMAC), rejecting cross-site form posts by `Origin`,
  OAuth2's `state` check, constant-time secret comparison, and rate
  limits. They live in `src/core/` (or a `src/dashboard/` area) as plain
  functions, tested like the rest.
- The HTTP server starts and stops with the bot: `shutdown.ts` closes it
  before the database, so no request touches a closed database, and the
  deploy's restart drops open long polls, which the helper retries.
- One process is the single point of failure for commands, reminders,
  the dashboard and the relay, as it already is for the first two. A slow
  page could delay the scheduler's loop; pages stay small and read from
  SQLite, which is fast and synchronous.
- Long-polling holds one open request per paired helper. Caddy's proxy
  has no read or write timeout by default (from a summary of its docs,
  checked in D1), and the bot answers each poll within a fixed time so
  nothing in between closes it as idle.
- Worth revisiting at D2 (editing: forms, validation, more routes), when
  hand-written routing and form handling grow. Hono is the first
  candidate then, as a new record superseding this one.
