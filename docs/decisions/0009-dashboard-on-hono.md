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
| **Hono 4 with `@hono/node-server` 2** | Two packages, neither with dependencies of its own; Node 20 or later | Routing; signed cookies (`setSignedCookie`, HMAC SHA-256); a CSRF middleware (for unsafe methods with a form-like content type, `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`, it accepts a request when either `Origin` matches or `Sec-Fetch-Site` is allowed, `same-origin` by default); an `html` template helper that escapes what it's given (implied by its docs, which say only `raw()` content isn't escaped). Requests and responses are the web-standard `Request` and `Response`. | Its JSX needs `.tsx` and a JSX transform, which type stripping doesn't do, so pages use the `html` helper. Two packages to keep updated. No built-in rate limiter (from memory). |
| `node:http`, `fetch` and `node:crypto` (Node 24 built-ins) | None | Nothing to update or audit, and every mechanism visible. Long-polling is a held response. | We write and test the routing, the cookie parsing and signing, the HTML escaping, the forged-post check and the rate limiter ourselves: small, but each a security bug if wrong. D2's forms and routes add more of this code. |
| Fastify, with its plugins | Many, transitively | The most mature: schema validation, and official plugins for cookies, CSRF, rate limits and OAuth2 | Far more than a few pages need; the most to keep updated. |
| Express | Many, transitively | The most examples | Older design; cookies, CSRF and rate limits all from separate packages. |
| A separate Next.js app (on Vercel, say) | Many, and a second app | A full React framework with familiar tooling | A second deploy, secrets in two places, and the bot still needs its own HTTP API through the tunnel for the dashboard's data and the helper. |
| Hono with JSX | As Hono, plus a build or loader | Nicer templates | Puts a build step into the run path, which the project avoids. |

## Decision

The dashboard and the helper's endpoint run in the bot process on Hono,
served through `@hono/node-server`, listening on `127.0.0.1` behind the
Cloudflare Tunnel. Pages are server-rendered with Hono's `html` helper.
OAuth2 uses `fetch`. Sessions use Hono's cookie helpers and
`node:crypto`. The helper talks to the bot by long-polling, so `ws`
isn't added. These two packages are the runtime dependencies the owner
approves for the dashboard (CLAUDE.md).

**Why:**

Hono is a familiar name in development and given its ridiculously fast and lightweight footprint, It seemed the most interesting and best way to handle this project. Personally I wanted a name that was familiar with recruiters and companies that I could put in my resume as something I have experience in. Also considered node:http but ultimately it would have given more work to do at this time. Its certainly something I will use in another project.

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
  `bot.db`, or a signed cookie; decided in D1), the helper's encrypted
  messages (below), the rate limiter, and which Discord servers a member
  may see (below).
- Other names under `alexle.dev` host the owner's other projects, and
  count as the same site as the dashboard. So session cookies are
  `HttpOnly`, `Secure`, `SameSite=Lax` and named with the `__Host-`
  prefix (Hono's cookie helper has an option for it, from memory; the
  cookie docs were read for signed cookies only), which
  forbids a `Domain` attribute and requires `Secure` and `Path=/`, so
  another name under the domain can't set or overwrite them. The CSRF
  middleware is given the exact origin
  `https://shrimp-fried-rice.alexle.dev`, not left to work it out from
  the request behind the tunnel, and its default `Sec-Fetch-Site` check
  accepts only `same-origin`. A sibling name is `same-site`, not
  `same-origin`, so it fails both checks, where `SameSite=Lax` alone would
  let its form post through. The middleware covers the browser pages
  only: `mcbridge` isn't a browser and sends neither header, so the
  helper's endpoint takes JSON and its own secret instead.
- Authorization is deny-by-default, as one missed check on one route
  would show a member another server's reminders or bridge settings,
  the dashboard's likeliest real security bug. Every route under a
  server's path goes through one middleware that checks the member is
  in that server (with the bot) and holds the permission the page needs,
  before any handler runs. A route outside it must be marked public
  explicitly. Tests call every route logged out and as a member of a
  different server, and a test fails if a route is neither guarded nor
  marked public (listing the app's routes; how, checked in D1).
- The helper's traffic is encrypted end to end, so Cloudflare, which
  decrypts HTTPS at its edge (0008), never sees relayed chat or the
  bridge's secret. Each request and response body is sealed with
  AES-256-GCM from `node:crypto` (no dependency on either end), under a
  key derived from the pairing secret with HKDF. GCM authenticates as
  well as encrypts, so one mechanism proves the request came from the
  paired helper and hides its content; the secret itself never crosses
  the wire. Each sealed body carries a timestamp and a random nonce, and
  the bot refuses one outside a 5-minute window or seen before in it, so
  a captured request can't be replayed. The bridge's id travels in the
  clear, bound into the seal (GCM's additional data) so it can't be
  swapped. Cloudflare still sees that a helper connects, when, how much,
  and from which address. HTTPS stays on underneath. Details are worked
  out in A8d (A8 in the plan).
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
  awaits the next message. Cloudflare's proxy gives up on an answer
  after 125 s (error 524), so the bot answers each poll within about 50
  s, with or without a message (inside the helper's 60 s lease, A8),
  which also stays below Node's own server timeouts (`requestTimeout`,
  300 s by default from memory, checked in D1). A poll whose helper
  disconnects is dropped (through the request's abort signal, checked in
  D1). Node's keep-alive timeout (5 s by default, from memory) must
  outlast `cloudflared`'s reuse of idle connections, or requests fail
  now and then with a 502; both are set in D1. Rate limits key on the
  visitor's address from Cloudflare's header, not the socket's (0008),
  which can be trusted only because the server listens on `127.0.0.1`
  and only `cloudflared` reaches it.
- Pages are tagged template strings, not JSX components. If templates
  grow unwieldy at D2, Hono's JSX with a loader is the step up, as a new
  record superseding this one.
