# 0009: The dashboard runs in the bot on Hono

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
protection against forged form posts, rate limiting, HTML escaping, and
a handful of read-only pages rendered on the server. A8 adds one
endpoint the helper long-polls, and left its transport to D0:
long-polling, or a WebSocket through the `ws` package. D2 (editing)
then adds forms, validation and many more routes.

Constraints: Node runs `src/` by type stripping, with no build, so no
JSX (CLAUDE.md). A runtime dependency is the owner's decision. `mcbridge`
is deliberately dependency-free ([0005](0005-minecraft-bridge-webhook-helper.md));
that's the helper on other people's machines, not the bot.

An earlier draft of this record (in PR #57's history) proposed no
framework, as the one option needing no owner decision. On 2026-11-23
the owner chose Hono instead.

Options (versions checked 2026-11-23 in each project's `package.json`:
[hono](https://github.com/honojs/hono/blob/main/package.json) 4.13,
[@hono/node-server](https://github.com/honojs/node-server/blob/main/package.json)
2.1; Hono's [Node.js](https://hono.dev/docs/getting-started/nodejs),
[CSRF](https://hono.dev/docs/middleware/builtin/csrf),
[cookie](https://hono.dev/docs/helpers/cookie),
[html](https://hono.dev/docs/helpers/html) and
[JSX](https://hono.dev/docs/guides/jsx) docs):

| Option | Runtime dependencies | What it brings | What it costs |
|---|---|---|---|
| **Hono 4 with `@hono/node-server` 2** | Two packages, neither with dependencies of its own; Node 20 or later | Routing; signed cookies (`setSignedCookie`, HMAC SHA-256); a CSRF middleware (on form posts, checks `Origin`, or `Sec-Fetch-Site` against `same-origin` by default); an `html` template helper that escapes what it's given (implied by its docs, which say only `raw()` content isn't escaped). Requests and responses are the web-standard `Request` and `Response`. | Its JSX needs `.tsx` and a JSX transform, which type stripping doesn't do, so pages use the `html` helper. Two packages to keep updated. No built-in rate limiter (from memory). |
| `node:http`, `fetch` and `node:crypto` (Node 24 built-ins) | None | Nothing to update or audit, and every mechanism visible. Long-polling is a held response. | We write and test the routing, the cookie parsing and signing, the HTML escaping, the forged-post check and the rate limiter ourselves: small, but each a security bug if wrong. D2's forms and routes would likely mean moving to a framework anyway. |
| Fastify, with its plugins | Many, transitively | The most mature: schema validation, and official plugins for cookies, CSRF, rate limits and OAuth2 | Far more than a few pages need; the most to keep updated. |
| Express | Many, transitively | The most examples | Older design; cookies, CSRF and rate limits all from separate packages. |
| A separate Next.js app (on Vercel, say) | Many, and a second app | The owner's strongest frontend stack | A second deploy, secrets in two places, and the bot still needs its own HTTP API through the tunnel for the dashboard's data and the helper. |
| Hono with JSX | As Hono, plus a build or loader | Nicer templates | Puts a build step into the run path, which the project avoids. |

## Decision

The dashboard and the helper's endpoint run in the bot process on Hono,
served through `@hono/node-server`, listening on `127.0.0.1` behind the
Cloudflare Tunnel. Pages are server-rendered with Hono's `html` helper.
OAuth2 uses `fetch`. Sessions use Hono's cookie helpers and
`node:crypto`. The helper talks to the bot by long-polling, so `ws`
isn't added. These two packages are the runtime dependencies the owner
approves for the dashboard (CLAUDE.md).

**Why:** TODO(Alex)

## Consequences

- `hono` and `@hono/node-server` join `discord.js`, `better-sqlite3` and
  `dotenv` in `package.json` in D1, and the deploy's `npm ci` installs
  them. Neither brings packages of its own. Updating them is ordinary
  maintenance; a new major version is checked against the dashboard's
  tests first. Whether their types check under TypeScript 6.0 (CLAUDE.md
  keeps it on `~6.0`) is checked when they're added.
- Routing, cookie signing, escaping and the forged-post check come from
  Hono, tested by its users, not written here. What's still ours, and
  tested: the OAuth2 flow and its `state` check, sessions (in
  `bot.db`, or a signed cookie; decided in D1), constant-time secret
  comparison for the helper, the rate limiter, and which Discord servers
  a member may see.
- Other names under `alexle.dev` host the owner's other projects, and
  count as the same site as the dashboard. So session cookies are
  `HttpOnly`, `Secure`, `SameSite=Lax` and named with the `__Host-`
  prefix (Hono's cookie helper has an option for it, from memory), which
  forbids a `Domain` attribute and requires `Secure` and `Path=/`, so
  another name under the domain can't set or overwrite them. The CSRF
  middleware is given the exact origin
  `https://shrimp-fried-rice.alexle.dev`, not left to work it out from
  the request behind the tunnel, and its default `Sec-Fetch-Site` check
  accepts only `same-origin`: `SameSite=Lax` alone would let a form post
  from a sibling name through.
- Handlers stay thin: they call the same plain functions the slash
  commands call (Track D's convention), so Hono stays at the edge and
  could be swapped without touching the logic.
- `@hono/node-server` returns a Node `http.Server`, so shutdown works as
  with `node:http`: `shutdown.ts` closes it before the database, so no
  request touches a closed database. `server.close()` waits for requests
  in flight, and a held long poll is one, so shutdown also ends open
  polls (answering them, or `server.closeAllConnections()`) instead of
  waiting for each to time out or for systemd to kill the process. That
  changes CLAUDE.md's shutdown rule and the README's shutdown note when
  it's built. The helper retries after the deploy's restart.
- One process is the single point of failure for commands, reminders,
  the dashboard and the relay, as it already is for the first two. A slow
  page could delay the scheduler's loop; pages stay small and read from
  SQLite, which is fast and synchronous.
- Long-polling holds one open request per paired helper: a handler that
  awaits the next message. Cloudflare's proxy gives up on an answer after
  125 s (error 524), so the bot answers each poll within about 60 s, with
  or without a message, which also stays below Node's own server
  timeouts (`requestTimeout`, 300 s by default from memory, checked in
  D1). A poll whose helper disconnects is dropped (through the request's
  abort signal, checked in D1). Node's keep-alive timeout (5 s by
  default, from memory) must outlast `cloudflared`'s reuse of idle
  connections, or requests fail now and then with a 502; both are set in
  D1. Rate limits key on the visitor's address from Cloudflare's header,
  not the socket's (0008), which can be trusted only because the server
  listens on `127.0.0.1` and only `cloudflared` reaches it.
- Pages are tagged template strings, not JSX components. If templates
  grow unwieldy at D2, Hono's JSX with a loader is the step up, as a new
  record superseding this one.
