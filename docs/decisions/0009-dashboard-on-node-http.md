# 0009: The dashboard runs in the bot on `node:http`, with no web framework

Status: Proposed · 2026-11-23

## Context

The dashboard needs a web server for its pages, Discord login, and the
helper's endpoint ([0006](0006-discord-to-minecraft-chat.md)). Track D's
plan leaned towards running it inside the bot process, which shares the
one database connection ([0004](0004-feature-storage-modules.md)) and the
live Discord client (channel lists, the reminder status embed, the
bridge's channel). A second process would need its own way to reach
both. A Cloudflare Tunnel sits in front
([0008](0008-dashboard-hostname-and-https.md)): `cloudflared` on the VM
connects to the server over plain HTTP on `127.0.0.1`.

What D1 needs: Discord OAuth2 (`identify`, `guilds`), sessions,
protection against cross-site requests, rate limiting, HTML escaping,
and a handful of read-only pages rendered on the server. A8 adds one
endpoint the helper long-polls, and left its transport to D0:
long-polling on `node:http`, or a WebSocket through the `ws` package.

Constraints: Node runs `src/` by type stripping, with no build, so no
JSX (CLAUDE.md). A runtime dependency is the owner's decision. `mcbridge`
is deliberately dependency-free ([0005](0005-minecraft-bridge-webhook-helper.md)).

Options (versions checked 2026-11-23 in each project's `package.json`:
[hono](https://github.com/honojs/hono/blob/main/package.json) 4.13,
[@hono/node-server](https://github.com/honojs/node-server/blob/main/package.json)
2.1; Hono's [CSRF](https://hono.dev/docs/middleware/builtin/csrf),
[cookie](https://hono.dev/docs/helpers/cookie) and
[JSX](https://hono.dev/docs/guides/jsx) docs):

| Option | Runtime dependencies | What it brings | What it costs |
|---|---|---|---|
| **`node:http`, `fetch` and `node:crypto` (Node 24 built-ins)** | None | Nothing to update or audit. Long-polling is a held response. | We write and test the routing, the cookie and form parsing, the HTML escaping, the cross-site check and the rate limiter ourselves: small, but security-relevant. |
| Hono 4 with `@hono/node-server` 2 | Two packages, neither with dependencies of its own; Node 20 or later | Routing, signed cookies (HMAC SHA-256), a CSRF middleware (checks `Origin` or `Sec-Fetch-Site` on form posts), an `html` template helper | Its JSX needs `.tsx` and a JSX transform, which type stripping doesn't do, so only the `html` helper is usable. Two packages to keep updated. |
| Fastify or Express | Many, transitively, plus plugins for cookies, CSRF and rate limits | The most documentation and examples | Far more than a few pages need; the most to keep updated. |

## Decision

The dashboard and the helper's endpoint run in the bot process, on
Node's `node:http`, listening on `127.0.0.1` behind the Cloudflare
Tunnel. No web framework: OAuth2 uses `fetch`, sessions and secrets use
`node:crypto`,
and pages are server-rendered strings through one escaping helper. The
helper talks to the bot by long-polling, so `ws` isn't added.

**Why:** TODO(Alex)

## Consequences

- No new runtime dependency, and nothing new in `package.json` for the
  deploy's `npm ci`.
- The security-relevant pieces are ours and need their own tests: HTML
  escaping, session cookies, rejecting forged form posts, OAuth2's
  `state` check, constant-time secret comparison, and rate limits. They
  live in `src/core/` (or a `src/dashboard/` area) as plain functions,
  tested like the rest.
- Other names under `alexle.dev` host the owner's other projects, and
  count as the same site as the dashboard. So session cookies are
  `HttpOnly`, `Secure`, `SameSite=Lax` and named with the `__Host-`
  prefix, which forbids a `Domain` attribute and requires `Secure` and
  `Path=/`, so another name under the domain can't set or overwrite them.
  And a form post is accepted only when its `Origin` is exactly
  `https://shrimp-fried-rice.alexle.dev`: `SameSite=Lax`, or a
  `Sec-Fetch-Site` check, would let a post from a sibling name through.
- The HTTP server starts and stops with the bot, and `shutdown.ts`
  closes it before the database, so no request touches a closed
  database. `server.close()` waits for requests in flight, and a held
  long poll is one, so shutdown also ends open polls (answering them, or
  `server.closeAllConnections()`) instead of waiting for each to time
  out or for systemd to kill the process. That changes CLAUDE.md's
  shutdown rule and the README's shutdown note when it's built. The
  helper retries after the deploy's restart.
- One process is the single point of failure for commands, reminders,
  the dashboard and the relay, as it already is for the first two. A slow
  page could delay the scheduler's loop; pages stay small and read from
  SQLite, which is fast and synchronous.
- Long-polling holds one open request per paired helper. Cloudflare's
  proxy gives up on an answer after 125 s (error 524), so the bot answers
  each poll within about 60 s, with or without a message, which also
  stays below Node's own server timeouts (`requestTimeout`, 300 s by
  default from memory, checked in D1). Node's keep-alive timeout (5 s
  by default, from memory) must outlast `cloudflared`'s reuse of idle
  connections, or requests fail now and then with a 502; both are set in
  D1. Rate limits key on the visitor's address from Cloudflare's header,
  not the socket's (0008), which can be trusted only because the server
  listens on `127.0.0.1` and only `cloudflared` reaches it.
- Worth revisiting at D2 (editing: forms, validation, more routes), when
  hand-written routing and form handling grow. Hono is the first
  candidate then, as a new record superseding this one.
