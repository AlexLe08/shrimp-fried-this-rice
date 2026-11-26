# Roadmap

Current status and next steps: what's done, what to do next, and
candidates for later. A session starting a task reads this first. A
feature's PR adds its own Done entry (and moves or removes its Next up or
Later item), not a follow-up.

## Done

- **First version** (2026-08-27 to 09-06, direct commits then #1). Started from the
  discord.js guide's command and event handlers. SQLite storage through
  `better-sqlite3`, with `storage.ts` as the only module that touches it;
  `/reminder` (create, edit, list, toggle, delete, master) and
  `/remindme`; the polling scheduler, guarded against overlapping
  checks; the self-updating `/reminder status` embed; a 3-second
  per-user cooldown on each command. A production incident, a command
  whose error reply also failed crashing the bot through an unhandled
  rejection, was fixed in #1 with a `try`/`catch` around the fallback
  reply. Commands are
  registered globally (`DISCORD_GUILD_ID` dropped), so the bot works in
  any server and `/remindme` in DMs. Deployed to an Oracle Cloud "Always
  Free" VM as the systemd service `discordbotshrimp`
  (`ORACLE_CLOUD_DEPLOYMENT.md`).
- **Tests and CI** (2026-09-08 to 09-12, #2, #3). Vitest against an
  in-memory SQLite, with small `vi.fn()` fakes for Discord, and a CI
  workflow (type-check and tests) that `main`'s ruleset requires. The
  tests caught one bug: `getDueGuildReminders` used an inner `JOIN` on
  `guild_settings`, so a server that never ran `/reminder master` (no
  row) never had its reminders sent. It's a `LEFT JOIN` treating no row
  as enabled. A regression test also reproduces #1's crash incident.
- **Per-server cap, graceful shutdown, deploy job** (2026-09-12 to 09-17,
  #4 to #6). At most 20 reminders per server. `SIGTERM`/`SIGINT` stop
  the scheduler, destroy the client and close the database, with a
  5-second force exit. The `deploy` job: after `test` passes on `main`
  and the owner approves, it SSHes into the VM, resets to `origin/main`,
  installs, restarts the service and re-registers commands.
- **Claude Code workflow** (2026-11-19, #8, decision 0001). `CLAUDE.md`,
  a worktree per task (`scripts/new-worktree.sh`), `scripts/check.sh`
  mirroring CI, the `reviewer` subagent, squash-merged small PRs, and
  decision records, after wol-character-panel.
- **Starter commands removed** (2026-11-19, #9). `/ping`, `/echo`,
  `/info`, `/server`, `/user` and `/reload` from the guide. `/echo` let
  any member make the bot post anything, mentions included, where they
  couldn't post themselves; `/reload` had no permission check.
- **Refused sends stop retrying every minute** (2026-11-19, #10). A
  reminder whose channel is gone is disabled and shows so in
  `/reminder status`. A send Discord refuses (missing permissions, DMs
  closed) is retried after the reminder's own interval. Network and 5xx
  errors are retried on the next poll, as before.
- **Shutdown waits for sends under way** (2026-11-19, #11). A deploy's
  restart no longer repeats a reminder that was mid-send. A check that
  throws is logged instead of crashing the process.
- **Housekeeping** (2026-11-19, #7, #12 to #15). MIT licence; the docs
  name the deploy job and the `discordbotshrimp` service; comments say
  why, not what; Dependabot's `undici` security bump. ESLint
  (typescript-eslint, type-aware promise rules) and Prettier, run by CI
  and `scripts/check.sh`, with TypeScript pinned to `~6.0` for
  typescript-eslint. Lint found two real problems, fixed in #15: a
  rejected event handler crashed the process (now logged, through
  `src/eventListener.ts`), and a failed `client.login` was unhandled (now
  logged, exit 1, so systemd restarts it).
- **Deploy hardening** (2026-11-19, #17 to #19). A failed command
  registration exits nonzero and fails the deploy; the VM installs with
  `npm ci`, exactly what CI tested; the deploy waits, until 60 s after
  the restart, for the bot's `Ready! Logged in as` line and fails if it
  doesn't appear. Registration failing doesn't skip that wait.
- **Snoozing and schema migrations** (2026-11-19, #20, decisions 0002 and
  0003). `/reminder snooze` and `unsnooze`, and `/remindme snooze:`:
  30 minutes to a week, with the choice of sending a missed reminder when
  the snooze ends or waiting a full interval. The first schema change:
  `storage.ts` applies migrations versioned by `PRAGMA user_version` on
  startup; migration 0 added `snoozed_until`, which production's database
  took on the deploy. Before the bot has users, a breaking schema change
  may reset the database instead (0003). `/reminder list` keeps under
  Discord's 2000 characters. The docs no longer say `better-sqlite3`
  compiles from source (13 ships a prebuilt `linux-arm64` binary).
- **Label autocomplete** (2026-11-19, #22). `/reminder edit`, `toggle`,
  `snooze`, `unsnooze` and `delete` offer the server's labels as you
  type, each choice naming its interval, channel, and whether it's
  disabled or snoozed. `interactionCreate.ts` routes autocomplete ahead
  of the cooldown check (one fires per keystroke) and logs a failed one.
  Typing a label by hand still works, so the "No reminder found" check
  stays.
- **Reminders as embeds** (2026-11-20, #23). Server and DM reminders send
  an embed: the label as the title (`Reminder` in DMs), the message, and
  an "Every N minutes" footer, in one fixed colour (per-reminder styles
  would need a schema change). Checked on the dev server: a mention inside
  an embed isn't a mention to Discord, and a link isn't previewed in a bot
  message that has its own embed. So `src/reminderMessage.ts` repeats a
  server reminder's user, role, `@everyone` and `@here` mentions above the
  embed (not ones in code, spoilers, or escaped; within 2000 characters),
  and sends a message with a link as plain text, as before, to keep its
  preview. `/reminder create` and `edit` warn when Embed Links is missing,
  and the scheduler sends plain text where it is: Discord refuses a bot's
  embed without it (50013, seen on the dev server), which would have kept
  that reminder from ever sending.
- **Embed or plain text, per reminder** (2026-11-20, #24). An `embed` option on
  `/reminder create`, `/reminder edit` and `/remindme`; off sends plain
  text, as before #23. Migration 1 adds `embed` (default 1) to
  `guild_reminders` and `user_settings`, so existing reminders stay
  embeds. `/reminder list` and the `/remindme` view show the choice.
- **Warnings for custom emoji the bot can't use** (2026-11-20, #25). The
  roadmap had blamed the input: checked on the dev server, the client
  sends `<:name:id>` whether an emoji is picked, autocompleted or typed on
  mobile. An emoji shows as `:name:` text when the bot can't use it: from
  a server it isn't in, or from another server without Use External
  Emojis in the channel (in a DM, being in the emoji's server is enough),
  embed or not. That can't be worked around, so `/reminder create`,
  `edit` (new message or channel) and `/remindme` name those emoji, and
  ones whose server lost the boost for them, and still save. The
  `GuildExpressions` intent keeps the bot's emoji list current, so an
  emoji added after startup isn't flagged.
- **Narrow client types for the scheduler and status embed** (2026-11-20, #28).
  `startScheduler` and `refreshGuildStatusMessage` take `SchedulerClient`
  and `StatusMessageClient`: what they call on the client, down to the
  channel, user and message, rather than all of `Client`. Narrowing only
  the parameter wouldn't have been enough, as the fakes' channels aren't
  discord.js channels either. The tests pass `createMockClient()` without
  `as unknown as Client`; a real `Client` still fits, checked by `tsc`
  at every call site. The fakes' `users.fetch` and `guilds.fetch` now
  reject for an unknown id, as discord.js does, instead of resolving
  `null`.
- **Refactor before the feature tracks** (2026-11-20 to 11-21, #31 to
  #38, [`plans/refactor.md`](plans/refactor.md)). No behaviour change,
  held to by a snapshot of every registered command (#31). `src/` split
  into `core/` and `reminders/` feature folders with one command loader
  (#32); the database in `core/database.ts`, each area's queries in its
  own `storage.ts`, decision 0004, and the file renamed `bot.db`, which
  reset production (#33); shared reply, time and message-length helpers
  in `core/discord.ts` (#34); `/reminder` as one handler per subcommand
  (#35); the scheduler running a list of named checks, so a feature adds
  one (#36); interaction routing, a typed `Event`, and `EmojiClient`
  (#37); shared guild, channel and reply fakes in the tests, and
  `npm run typecheck` (so CI) checking `test/` too, through
  `test/tsconfig.json` (#38). A dropped import in #38 had passed lint
  and `typecheck` and failed only when the tests ran, as Vitest strips
  types unchecked.
- **Trial FC member follow-ups (`/recruit`)** (2026-11-21, #39 to #41,
  three stacked PRs, Track E1 of
  [`plans/minecraft-ff14-features.md`](plans/minecraft-ff14-features.md)).
  Moderators record trial members by in-game name with a note; when the
  follow-up is due (30 days by default) the bot posts once in the
  configured channel, pinging only the configured role, and the entry stays
  on `/recruit list` until resolved, snoozed or removed. The first feature
  storage module (`src/ffxiv/recruit/storage.ts`, decision 0004) and
  migration 2. One change from the plan: a refused post or a missing
  channel pauses that server's follow-ups (kept pending, shown in
  `/recruit list` and `config`, resumed by `/recruit config channel:`)
  instead of marking each entry failed. From review: a server's due
  follow-ups go out as one post per poll with a single ping (a backlog of
  up to 100 would have pinged once each), and `/recruit config` takes only
  a role the moderator could ping themselves, never `@everyone`. Not yet tried on a live server,
  including whether Mention Everyone lets the bot ping a role that doesn't
  allow mentions.
- **Minecraft bridge, first version** (2026-11-21, #43 to #47, Track A
  of [`plans/minecraft-ff14-features.md`](plans/minecraft-ff14-features.md),
  decision 0005). `mcbridge`, a helper with no dependencies beyond Node 24,
  runs beside a vanilla server, tails `latest.log`, and posts start and
  stop, joins and leaves, chat under each player's name (its Markdown
  escaped, so it reads as typed: the owner's call), and real errors to
  Discord through webhooks; setup in
  [`MINECRAFT_BRIDGE.md`](MINECRAFT_BRIDGE.md). The noise rules came from
  the owner's real 26.3 logs: lag alerts only when it repeats, the same
  error is posted once and then counted, at most 5 alerts a minute. From
  review: the tailer follows a replaced log by inode (a new one can outgrow
  the old offset between polls) and scans only the last 1 MiB at startup;
  the sender posts with `wait=true` (otherwise Discord reports success for
  a message it didn't save), bounds its 429 retries, times requests out,
  and resends a post Discord refuses under a player's name as the server,
  naming the player on each line. The owner's end-to-end test (2026-11-21,
  macOS) passed against webhooks in a test channel, both with hand-written
  log lines and with a real vanilla server. It settled two Discord
  behaviours: Discord refuses `clyde` in a message's username, so the
  fallback to the server's name is needed, and it hides the backslashes
  that escape chat. Not yet tried on Windows, nor run from the Task
  Scheduler, launchd or systemd setups.
- **Minecraft bridge crash reports** (2026-11-21, Track A7). An optional
  `crashReportsDir`: `mcbridge` polls it every 5 s and posts each new
  report, once its size has stopped changing, as a "Crashed" alert with
  the report's description, exception and file name. It goes through the
  alert gate, so a server crashing on every restart posts once and then a
  count, but never for the per-minute cap (a crash follows a burst of the
  log's own errors, which could fill it). Reports there at startup aren't posted. Tested end to end by
  the owner with a real vanilla report (from the game client, made with
  F3+C; the same layout as the server's): the alert, a copy of the same
  report counted in the shutdown summary instead of posted again, and
  reports present at startup skipped, all as expected.
- **Minecraft player avatars** (2026-11-21, #51, Track A4b). An `avatars` key in
  the `mcbridge` config gives each player's chat lines a picture: by
  default one of 10 bundled pixel-art heads (`assets/mcbridge-avatars/`,
  placeholders the owner may redraw under the same names) picked by a hash
  of the name, so nothing about a player leaves Discord; `skin` for players
  who opt in, from mc-heads.net by the UUID logged at login (crafatar has
  blocked Discord; minotar 404s an unknown name); a picked picture, an
  `https` link, or none. An offline-mode UUID gets a generated picture,
  not the skin of whoever owns the name on Mojang's side. Tested end to end
  by the owner on Discord desktop and mobile: the default pictures, a skin
  by UUID, a picked picture, a link, none, logging in again while online,
  an offline-mode server, and a refused config all behaved as expected. A
  picture can show Discord's default avatar for a moment before it loads,
  never longer.
- **RCON client for two-way chat** (2026-11-22, Track A8a).
  `src/minecraft/bridge/rcon.ts`, on `node:net` only, for the helper to
  run `tellraw` once two-way chat is wired up (A8e); nothing uses it yet.
  It logs in, runs one command at a time with a 5 s timeout, reconnects
  after a drop (1 s, doubling to 60 s, starting over once a connection
  has lasted 30 s), and stays off after a wrong password, with one
  callback for the alert. A command cut off by a dropped connection is
  retried once; one that timed out isn't, as a lagging server still runs
  it and a retry would show it twice. Two timeouts in a row, or TCP
  keepalive, reopen a connection that died silently. Commands must be
  printable ASCII within the wiki's 1446 bytes; the password and replies
  are UTF-8. From review, recalled from vanilla's source but not
  checked: vanilla reads one packet per read and drops a read holding
  two (hence one command at a time), and uses UTF-8. Tested against a
  fake RCON server; not yet tried against a real Minecraft server (A8h
  checks both, and measures the real command limit).
- **`tellraw` builder and `server.properties` reader** (2026-11-22, Track
  A8b). `src/minecraft/bridge/toMinecraft.ts` turns a Discord sender,
  text and the bridge's prefix and colour into `tellraw @a` with a
  JSON-style component: one line, no `§` or control characters,
  non-ASCII as `\uXXXX`, cut with `…` (never inside an emoji) to fit
  RCON's limit, everything typed kept inside its string by
  `JSON.stringify`. `src/minecraft/bridge/serverProperties.ts` reads the
  file as the server does (UTF-8, else ISO-8859-1; Java properties
  syntax) and gives RCON's port and password, or why it's off, and
  `online-mode`. Nothing uses either yet (A8e). Whether 26.3 accepts the
  component and its escapes is for the end-to-end test (A8h).
- **The `!link` line** (2026-11-22, Track A8c). `classify.ts` reads a
  chat line starting `!link` as its own event, with the code only when
  the text is exactly `!link` and six digits (anchored like chat, so only
  that player can produce it). `bridge.ts` posts it as ordinary chat, as
  before, unless it is given a `link` option, which only pairing will
  pass (A8e): then no `!link` line reaches Discord, and a well-formed one
  is reported with the player's UUID from this run's login line (or none
  after a restart) and `online-mode`. Codes in the log read at startup
  are never reported. Nothing passes the option yet. Tested from a
  hand-written fixture; no real `!link` line has been logged yet (A8h).
- **Dashboard decisions** (2026-11-23, Track D0; accepted by the owner
  that day). Two records, as a tunnel brings its own hostname and
  certificate, so the three D0 choices are two:
  [0008](decisions/0008-dashboard-hostname-and-https.md) serves the
  dashboard at `shrimp-fried-rice.alexle.dev`, on the owner's own domain
  (bought at Porkbun, the one exception to free tiers only, DNS on
  Cloudflare's free plan), through a Cloudflare Tunnel with no inbound
  port on the VM (Caddy on the same name is the fallback; free names
  were weighed first, and deSEC's has suspended sign-ups), and
  [0009](decisions/0009-dashboard-on-hono.md) runs it in the bot on
  Hono (the owner's choice of dependency), the helper long-polling.
  Facts checked against each provider's docs that day; what couldn't be
  is marked in the records.
- **Snapshots of `bot.db` on the VM** (2026-11-23, first part of backing up
  `bot.db`). `src/core/backup.ts` writes complete copies with `VACUUM INTO`
  to `backups/` beside the database (created `0700`), through a `.tmp`
  file renamed once finished, as SQLite's docs warn a cut-off one can be
  corrupt. One before pending migrations (newest 5 kept; if it fails the
  bot exits unmigrated, so the deploy's login check reports it; one at
  the same version from the last 10 minutes is reused, so a migration
  failing in systemd's 5 s restart loop doesn't push the older ones out),
  none for a new database or `:memory:`, and a daily scheduled check
  (newest 7 kept) timed from the newest snapshot's name, retrying an hour
  after a failure. Checked: SQLite fsyncs the output when the source's
  `synchronous` is NORMAL or FULL
  ([`lang_vacuum.html`](https://www.sqlite.org/lang_vacuum.html), read
  2026-11-23; the bot's is NORMAL, from a probe on `better-sqlite3`'s
  SQLite 3.53.4), and a snapshot is in rollback-journal mode, which
  `database.ts` switches to WAL when one is restored as `bot.db`. The
  folder isn't fsynced after the rename, so a power loss right after one
  could lose that snapshot (not the earlier ones). From review, not
  changed here: `deploycommands` imports `database.ts` too, so on a
  deploy with a migration it races the restarted bot to migrate (as
  before this) and to snapshot. Not yet run on the VM.
- **`bot.db` readable only by the bot's user** (2026-11-23, second part
  of backing up `bot.db`). `core/database.ts` sets `bot.db` to `0600` on
  every start (creating a new one that way) and any `-wal` and `-shm`
  left over; snapshots are `0600` before they're renamed into place, and
  saving one sets earlier ones (the umask's mode, inside the `0700`
  folder) the same way, so the first daily one after the deploy fixes
  them. Done
  in code rather than with `UMask=0077` in the systemd unit, as planned:
  the unit lives only on the VM, outside the deploy, and a probe on
  `better-sqlite3`'s SQLite 3.53.4 showed SQLite gives `-wal` and `-shm`
  the database's own mode whatever the umask, so a umask alone would have
  left them `0644` beside a `0644` `bot.db`. A failed `chmod` is logged
  and the bot runs on. Not yet run on the VM.
- **Encrypted copies of `bot.db` off the VM** (2026-11-24, third part of
  backing up `bot.db`; [decision 0011](decisions/0011-off-vm-backups.md)).
  `src/core/offsiteBackup.ts`, a scheduled check after the daily one,
  encrypts the newest daily snapshot not yet sent to the owner's age
  public key with `age-encryption` 0.3.1 (a new runtime dependency,
  approved in the decision) and `PUT`s it to a bucket's write-only
  pre-authenticated URL, under a new name each attempt; what was sent is
  kept in `backups/offsite-upload.json`. A failure is logged without the
  URL and retried hourly; shutdown aborts an upload under way. Once the
  newest copy is over 48 hours old, the application's owner (or its
  team's owner, from `client.application.fetch()`, so no new `.env`
  value) gets a DM once a day. Off unless `BACKUP_UPLOAD_URL` and
  `BACKUP_AGE_RECIPIENT` are both set, and a malformed one is refused at
  startup with a log line. Checked: `age-encryption` does X25519 through
  WebCrypto (`crypto.subtle`), so tests await each run for real between
  fake-timer polls; a bucket PAR's URL ends in `/o/` and an upload is a
  `PUT` with the name appended (Oracle's docs, 2026-11-24; the success
  status isn't stated, so any 2xx counts). The console setup is
  `ORACLE_CLOUD_DEPLOYMENT.md`'s section 10, for the owner. Set up and
  deployed 2026-11-24 (#62): the first copy reached the bucket, and the
  owner downloaded it and decrypted it with the age key into a working
  database. The console paths in section 10 were corrected from that
  walk-through. The stale-upload DM is not yet tried in Discord.
- **Restore procedure for `bot.db`** (2026-11-24, last part of backing up
  `bot.db`, which the owner put first in Next up on 2026-11-23 after
  reviewing decisions 0001 to 0009 for serious consequences). `ORACLE_CLOUD_DEPLOYMENT.md` section 11: which copy to restore
  (a pre-migration snapshot, a daily one, or an off-VM copy after
  rebuilding the VM), getting an off-VM copy onto the VM, a check of a copy
  through the project's own `better-sqlite3` (the VM may have no `sqlite3`),
  and the steps: stop, set `bot.db` aside with its `-wal` and `-shm`, copy
  in, start. Tried locally on throwaway databases first, which shaped
  that step: after a crash `bot.db` alone held 4 KB and its `-wal` the
  rest, and a `-wal` left beside a restored file was replayed into it, so
  the restore came up with the old rows and `integrity_check` still said
  `ok`. A drill restores a `VACUUM INTO` copy made right after stopping
  the bot, so trying it loses nothing (checked locally: it includes what's
  still in the `-wal`). The owner ran the drill on the VM on 2026-11-24,
  after #64 merged, and it worked. Decision 0011 asks for it again after
  a large schema change or every few months.
- **The dashboard's web server** (2026-11-24, first part of D1;
  decisions 0008 and 0009). `hono` and `@hono/node-server` join
  `package.json`. `src/dashboard/server.ts` serves the app on `127.0.0.1`
  at `DASHBOARD_PORT` (off without it; a malformed or taken port is
  logged and the bot runs on), with only `/health` so far; shutdown stops
  it first, finishing requests under way and cutting off any still going
  after 2 s (before `index.ts`'s 5 s forced exit). Checked: `cloudflared` keeps an
  idle connection to the origin for 90 s by default (Cloudflare's origin
  parameters, 2026-11-24) and Node closes one after 5 s, which would fail
  `cloudflared`'s next request on it with a 502, so the server keeps them
  for 100 s; a probe on Node 24.21 showed a socket idle for 70 s, past
  `headersTimeout`'s 60, still answered. Node 24's `server.close()`
  closes idle connections itself, so shutdown doesn't wait on them.
  `overrideGlobalObjects: false` stops `@hono/node-server` replacing the
  process's global `Request` and `Response`. Installing `cloudflared` and
  the route are `ORACLE_CLOUD_DEPLOYMENT.md` section 12, which the owner
  followed on the VM on 2026-11-24: `/health` answered `ok` on the VM and
  through `https://shrimp-fried-rice.alexle.dev`.
- **Dashboard login sessions** (2026-11-24, second part of D1). Stored
  in `bot.db`, the owner's call that day over a signed cookie (decision
  0009 left it to D1): a session can be ended on the server, and a
  cookie that's no longer wanted stops working. Migration 3 adds
  `dashboard_sessions`. The cookie will hold 32 random bytes; the table
  keeps only their SHA-256, so a snapshot or off-VM copy can't sign
  anyone in. A session lasts 7 days from login, a user keeps at most 10,
  and expired ones are deleted when anyone logs in (until then they sign
  no one in). Discord login uses them (below).
- **Dashboard login with Discord** (2026-11-24, third part of D1).
  `/login`, `/auth/callback` and `POST /logout`, and a home page that
  says who is signed in. OAuth2 with `identify` only; the `state` is
  kept in a 10-minute `__Host-` cookie and compared in constant time, so
  a callback from a login another browser started is refused. Discord's
  token is used once, for `/users/@me`, then revoked. The session cookie
  is `__Host-session` (`HttpOnly`, `Secure`, `SameSite=Lax`), and a new
  login ends the browser's earlier session. Hono's CSRF check, given the
  exact public origin and `Sec-Fetch-Site: same-origin`, guards form
  posts; Hono's security headers on every response, with
  `Referrer-Policy: same-origin` (its default, `no-referrer`, makes
  browsers send `Origin: null` on the dashboard's own form posts, from
  review), a CSP allowing nothing but form posts to the dashboard, and
  `Cache-Control: no-store`. Logins are capped at 30 a minute for the
  whole dashboard, and stop until Discord's `Retry-After` after a 429:
  anyone can start one, and Discord blocks an IP after 10,000 refused
  requests in 10 minutes (its rate limit docs, 2026-11-24), which would
  cut the bot off too. Off without
  `DISCORD_CLIENT_SECRET` and `DASHBOARD_URL` (`ORACLE_CLOUD_DEPLOYMENT.md`
  section 13, for the owner). Checked against Discord's OAuth2 docs
  (2026-11-24): the token exchange is a form post with HTTP Basic client
  credentials, and Discord recommends `state`. Set up by the owner on
  2026-11-24 (section 13), and logging in through Discord and logging
  out both worked on the live dashboard. The first try showed Discord's "Invalid OAuth2
  redirect_uri" although the bot sent the right one: the redirect wasn't
  yet saved on the production application. Section 13 now says so.
  Whether a browser keeps a `Secure` cookie on `http://127.0.0.1` for
  local login isn't checked.
- **Dashboard server list, guarded per server** (2026-11-24, fourth
  part of D1). `/servers` lists the servers the bot is in where the
  user has Manage Server, and `/servers/<id>` shows one (its name, until
  the reminders page). The owner's call that day ([decision
  0012](decisions/0012-dashboard-checks-server-access-itself.md)): the bot checks for
  itself rather than asking for the `guilds` scope at login, so
  permissions are current on every page, not as they were at login.
  `dashboard/access.ts` asks Discord with `members.fetch({ force: true })`:
  without the privileged Server Members intent the bot isn't told of
  role changes, so a cached member could keep a lost permission. From
  review: each answer is reused for 30 s (a check under way is shared),
  as each is a call in the request queue reminders share and any
  signed-in visitor could otherwise reload a page into it; and a member
  in timeout is refused, which discord.js's permissions ignore. One guard on `/servers/:guildId/*` (which Hono matches for
  `/servers/:guildId` too; registering both ran it twice) answers the
  same 404 for a server the bot isn't in, a non-member and a member
  without Manage Server. `ROUTE_ACCESS` lists every route as public,
  signed-in or server, and a test fails for one served but not listed
  (decision 0009's deny-by-default check), then tries every non-public
  route signed out and every server route as another server's manager.
  Tried by the owner on the live dashboard on 2026-11-24 after the
  deploy: the list showed the servers where they have Manage Server, as
  expected.
- **Dashboard reminders page** (2026-11-24, fifth part of D1).
  `/servers/<id>` lists the server's reminders, read-only: the master
  toggle, then each one's label, channel, interval, embed or plain text,
  message and where it stands. Where it stands moved out of the status
  embed into `reminders/reminderState.ts`, which both use, so the page
  and `/reminder status` can't disagree (the embed's tests pass
  unchanged). Channel names come from the bot's cache (no Discord call);
  one it can't see shows by its ID. Times are worked out on the server,
  as the CSP allows no scripts, with the exact UTC time as a tooltip.
  No new route, so `ROUTE_ACCESS` and the guard are unchanged. Tried by
  the owner on the live dashboard on 2026-11-24 after the deploy: a
  reminder created in Discord showed on the server's page.
- **Dashboard rate limits** (2026-11-24, sixth and last part of D1).
  `dashboard/rateLimit.ts`, fixed windows counted in memory (a restart
  clears them; no new dependency, as Hono has none built in): 60
  requests a minute per visitor (`/health` aside), 5 logins in 10
  minutes per visitor, checked before the dashboard-wide 30 a minute so
  one visitor can't use that up, and 30 signed-in pages a minute per
  account across its sessions and addresses. Together with the
  dashboard-wide cap, the per-visitor login limit is what slows new
  accounts piling up access checks (decision 0012). Answers are 429
  with `Retry-After`. A visitor is keyed on `CF-Connecting-IP`, an IPv6
  address by its /64; no usable address shares one count, logged once
  so a header that doesn't arrive shows in the journal. Past 10,000
  keys in a window, new ones share one count, so memory stays bounded.
  Checked against Cloudflare's HTTP headers docs (2026-11-24): the
  header carries the visitor's address to the origin. Neither those docs
  nor the Tunnel docs say Cloudflare replaces a value the client sent,
  or that the header reaches a tunnel origin, so the owner checked both
  on the live dashboard on 2026-11-24 after the deploy: the journal had
  no line about a missing `CF-Connecting-IP`, 61 loads in a minute from
  one machine got a 429 while another network still loaded, and
  requests sending forged `CF-Connecting-IP` values were still limited
  by the real address.
- **Minecraft bridge storage** (2026-11-24, first part of A8d). One
  additive migration (version 5) and `src/minecraft/storage.ts`: bridges
  (channels, webhooks, the keys derived from the pairing secret, server
  name, prefix, colour, default picture, the announced channel and the
  last relayed message id), pictures set by a bridge's managers, links,
  and who may manage bridges. Worked out from the plan's rough tables:
  a bridge's id is 128 random bits rather than a row number, as it
  travels in the clear and keys the per-bridge rate limit, so a stranger
  can't guess one and use up its limit; two keys are kept, one per
  direction, so a sealed reply can't be sent back as a request; the
  allowed role is per server, not per bridge, as adding the first
  bridge already needs it; and no foreign keys (SQLite enforces them
  only with a per-connection pragma that's off), so storage deletes a
  bridge's rows together in one transaction. The last relayed id only
  moves forward, compared as a snowflake. Linking a name again keeps
  its picture only for the same member and account. `GuildDelete`
  (`src/minecraft/events/guildDelete.ts`) deletes a server's bridges,
  pictures, links and settings; checked in discord.js 14.27's source
  that a server lost to an outage emits `GuildUnavailable` instead, so
  an outage wipes nothing. Nothing else uses the tables yet. A server
  the bot is removed from while it's offline (a deploy's seconds) keeps
  its rows, as `GuildDelete` never comes; see Later.
- **Sealing the Minecraft helper's messages** (2026-11-24, second part of
  A8d). `src/minecraft/bridge/seal.ts`, for both the bot and `mcbridge`
  (only `node:crypto`, so the helper stays dependency-free): a new
  pairing secret, its two keys (HKDF-SHA256, one per direction),
  sealing and opening with AES-256-GCM, checking an envelope before
  anything is looked up, and a replay guard (a 5-minute window either
  side, each nonce once, and nothing sealed before the bot started, so
  a request captured before a deploy can't be replayed after it, though
  nonces live only in memory). Worked out here: the IV doubles as the nonce;
  the tag also covers the route and, for a response, the request it
  answers, so a captured reply can't answer a later request; the time
  is checked apart from opening, so the bot can answer a skewed clock
  sealed; and the decipher sets the tag length, as Node otherwise
  accepts a truncated tag (DEP0182, checked in Node 24's docs). The
  derived keys and a sealed body are pinned by tests, so a change that
  would lock out running helpers fails. Not wired up yet: nothing calls
  it until the routes.
- **The Minecraft helper's endpoint** (2026-11-24, third part of A8d).
  `POST /minecraft/connect` and `POST /minecraft/poll` on the dashboard's
  server (`src/minecraft/helperRoutes.ts`), with each helper's session,
  held poll and waiting messages in memory (`src/minecraft/helperHub.ts`).
  A request is checked cheapest first: 240 a minute per address, JSON of
  at most 16 KiB, a well-formed envelope, 120 a minute per bridge before
  the lookup, then the seal and the replay guard. Refusals before the seal
  opens are in the clear (400, 401 for an unknown bridge and a forged seal
  alike, 413, 415, 429); every answer after it is sealed, so nobody on the
  way can fake a "taken over". A poll is held up to 50 s; a new connection
  takes the bridge over (the old session gets 409); a session that lapsed
  (60 s after its last poll) or that a restart forgot gets 410 and
  connects again; messages wait up to 30 s, at most 200 a bridge. Worked
  out here: the helper's routes skip the pages' 60-a-minute limit, as a
  busy channel means about a poll per message; `@hono/node-server` 2.1
  aborts a request's signal when its helper hangs up (read in its source,
  then tested against the real server), so a held poll lets go without
  taking a message; and shutdown answers held polls at once, then keeps
  closing connections as they go idle, as `server.close()` closes only
  those idle when it's called (found by the new shutdown test, which
  otherwise waited out the grace period). Not used yet: no bridge can be
  paired until the next part, and nothing delivers messages until the
  relay (A8e). Not tried through the real tunnel.
- **Pairing a Minecraft bridge** (2026-11-24, fourth part of A8d).
  `src/minecraft/pairing.ts`: `pairBridge` makes a bridge's chat and
  alerts webhooks and a new secret, stores only the keys derived from it,
  and returns the `mcbridge.json` to download (`logPath` left blank);
  `regenerateBridge` replaces the secret and both webhooks and deletes the
  old ones. Who may: the server's owner or the allowed role, not in
  timeout (`canManageBridges`). Everything is checked before a webhook is
  made, so a refusal leaves nothing behind: the server name by the
  helper's own rule (now shared from `config.ts`), each channel a text or
  announcement channel (a forum takes webhooks only into a thread), the
  member able to see it and manage its webhooks (also on regenerate, as
  the config holds the webhook URLs), and the bot with View Channel,
  Manage Webhooks and, in the chat channel, Read Message History for the
  catch-up (decision 0010). If Discord refuses the second webhook, the
  first is deleted. Worked out here: the webhooks are named
  "Minecraft chat" and "Minecraft alerts" rather than after the server,
  as Discord holds a webhook's name to its nickname rules and the helper
  names each post itself; regenerating deletes the webhooks the row held
  when the new ones were saved (read and replaced with no `await`
  between), so two at once leave no live webhook unrecorded, and an old
  one Discord wouldn't delete is returned for the page to name, as it
  still posts. The helper's config now accepts the `bot` key (an https
  address, http only on loopback, and the 32-byte secret, never quoted in
  an error); nothing reads it until A8e. Checked against Discord's docs
  (2026-11-24): Manage Webhooks for creating and deleting, names of 1 to
  80 characters without `clyde` or `discord`, 15 webhooks a channel
  (30007) and 1000 a server (30058), and an audit-log reason, which names
  the member. From review: at most 10 bridges a server
  (`MAX_BRIDGES_PER_GUILD`, as each takes two of a channel's 15
  webhooks); webhooks made for a pairing that then fails, the database
  included, are deleted, with their token so it needs no permission;
  regenerating returns what it saved rather than reading it again, and
  refuses if the channels changed meanwhile. Not used yet: the
  dashboard's pages (A8f) call it; not tried against Discord.
- **Links of members who left** (2026-11-24, last part of A8d).
  `fetchLinkedMember` (`src/minecraft/linkedMember.ts`) asks Discord for a
  link's member, not the cache, as without the Server Members intent the
  bot isn't told when someone leaves. Only Unknown Member (10007) and
  Unknown User (10013, a deleted account; the owner's call, 2026-11-24,
  as the dashboard's access check reads it the same way) delete their
  links on that server's bridges; a network error, a 5xx, a rate limit or
  anything else keeps them and is logged, and the caller falls back to
  the bridge's pictures. Checked in Discord's docs (2026-11-24): 10007 is
  Unknown Member, 10013 Unknown User, and only listing
  members needs the Server Members intent, not fetching one (the
  dashboard's access check already does so on the live site). It takes a
  narrow `LinkedMember` (`displayAvatarURL`, the plan's `discord`
  picture) rather than a generic member type, as `members.fetch` is
  overloaded and TypeScript would infer its `Collection` overload; a real
  `Guild` fitting is pinned by a type test. Not used yet: A8e looks the
  member up when the helper reports a player joining; not tried against
  Discord.
- **Reading bridge chat channels** (2026-11-24, first part of A8e).
  The bot asks for the `GuildMessages` and privileged Message Content
  intents, and `src/minecraft/relay.ts`, from a `MessageCreate` event,
  queues a member's message in a bridge's chat channel on the running
  dashboard's `HelperHub` as their server nickname and plain text
  (mentions and custom emoji as names through discord.js's
  `cleanContent`, `[image]`, `[file]`, `[sticker]`, `(reply to Name)`),
  at most 5 a second per bridge, and records its id as the last relayed.
  Only once the relay was announced in that channel (decision 0006);
  webhooks, apps, Discord's own messages and slash command replies are
  skipped. Checked in discord.js 14.27's source: `cleanContent` names
  cached members, roles and channels and turns `<:name:id>` into
  `:name:`; a reply's author comes from the gateway's
  `referenced_message`, so a reply to a relayed game message names the
  player, as its webhook carries their name; and `message.system` counts
  slash command replies as members' messages, so the type is checked
  instead. From review: the client caches no message
  (`src/core/clientOptions.ts`), as discord.js would otherwise keep the
  last 200 of every channel in every server, against the relay's promise
  to keep nothing; and a message queued just before a restart is recorded
  as relayed but lost with the queue, so the catch-up skips it (a few
  milliseconds while a helper polls; accepted). README's Local Setup and `ORACLE_CLOUD_DEPLOYMENT.md` now ask
  for Message Content on both apps (gateway close code 4014 otherwise,
  checked in `discord-api-types`). Not used yet: nothing announces a
  bridge until the dashboard's pages (A8f), and no helper polls until
  its side; not tried against Discord.
- **Announcing the relay** (2026-11-24, second part of A8e).
  `src/minecraft/announcement.ts` posts decision 0006's opt-in in a
  bridge's chat channel through its chat webhook, under the server's
  name with no pings, and records the channel, which the relay needs
  before it reads it. Posted when the helper is first active (any sealed
  request to the endpoint), not at pairing (the owner's call,
  2026-11-24), so it comes when chat starts to flow, and one place covers
  a chat moved to another channel and a refused post: tried again at most
  every 10 minutes, and not for a webhook Discord says is gone (10015)
  until it's regenerated. Two requests at once post once; nothing is
  recorded if the bridge changed while posting or once shutdown began
  (the dashboard closes the announcer before the database closes).
  Checked in discord.js 14.27's source: `WebhookClient` takes the
  webhook's id and token, and `send` takes `username` and
  `allowedMentions`; 10015 is Unknown Webhook in `discord-api-types`. Not
  used yet: nothing pairs a bridge until A8f, and no helper connects
  until its side; not tried against Discord.
- **Catching up after a restart** (2026-11-24, third part of A8e;
  decision 0010). Once ready, `src/minecraft/catchUp.ts` asks Discord's
  API for each relaying bridge's chat since the last relayed message (or
  5 minutes back, if later), keeps the oldest 20 members' messages, and
  queues them for the helper's next poll for up to 2 minutes. Live
  messages wait meanwhile and follow them; the first live one marks where
  the catch-up stops, and the live relay now skips anything at or before
  the last relayed id, so nothing goes twice. From review: the
  announcement now also records its own message id as the last relayed,
  so after a chat moves, a catch-up can't relay what was posted in the new
  channel before its announcement (decision 0006); held live messages are
  counted against the 5 a second as they arrive, not all at release, and
  wait at most 10 s; and each caught-up author's member is asked of
  Discord once, as API messages come without it and the cache is cold
  after a restart, so they show under their server nickname. Checked in Discord's docs
  (2026-11-24): `after`, `limit` 1 to 100, an answer listed newest first
  (which messages `after` picks isn't said, so it asks for 100 and sorts),
  and no messages, rather than an error, without Read Message History.
  Left to the helper's part: pacing caught-up messages into the game, and
  dropping them while the server is down (the bot doesn't know yet). Not
  used yet; not tried against Discord (A8h: a deploy with messages posted
  during it).
- **The helper's connection to the bot** (2026-11-25, fourth part of
  A8e). `src/minecraft/bridge/botClient.ts` connects and long-polls the
  bot's endpoint, sealed, and hands on the chat it gets: on a 410 it
  connects again, on a sealed 409 or a 401 it stops until restarted with
  one callback for the alert, it waits out a 429's `Retry-After`, backs off
  from 1 s doubling to 60 s on anything else (an unsealed 409 or a 403
  included, as anyone on the way or Cloudflare could send them), and
  corrects for its clock from the bot's sealed time. From review: a
  `bot.url` without its slash, a throwing callback (logged, not fatal), a
  connect without a session (backs off) and empty polls answered at once
  (1 s apart). Found here: pairing's
  config didn't name the bridge, which every sealed request carries; it's
  now `bot.bridge`, required (no config has been handed out yet). Tested
  against the bot's real routes and a scripted fake bot. Not started by
  `main.ts` yet, as connecting announces the relay before the helper can
  run `tellraw` (next: RCON); not tried through the real tunnel.
- **Into the game** (2026-11-25, fifth part of A8e).
  `src/minecraft/bridge/gameRelay.ts` reads `server.properties` at each
  server start, connects RCON, and sends chat from the bot as `tellraw
  @a`, one command at a time at most 5 a second in order, dropping chat
  while the server is down (waiting chat included) and chat that waited
  over 10 s (at most 50 wait). It stays off, with one
  alert per reason naming the fix and never quoting the password, when
  the file can't be read or parsed, RCON is disabled, the password is empty or
  refused, the port isn't one, or the password is weak: under 12
  characters, fewer than 5 different ones, or letters made only of common
  words (accepted by the owner, 2026-11-25). The config takes
  `serverPropertiesPath` and `rcon` (host, port), refused without `bot`.
  Not wired in yet (next); not tried against a real server (A8h).
- **Two-way chat in the helper** (2026-11-25, last helper part of A8e).
  With `bot` in its config, `mcbridge` starts the connection to the bot
  and the game relay: chat from Discord goes into the game. The log's
  start line and the startup scan (unless it says the server is stopped)
  read `server.properties` and connect RCON; the stop line disconnects,
  and while two-way chat is on the stop message adds "Messages sent here
  won't reach the game until it's back." RCON not connecting for 2
  minutes posts one alert naming where it tried (`rcon.ts`'s new
  `onUnreachable`), and a helper taken over or refused posts one alert
  saying what to do. Shutdown stops the connection and closes the relay
  after the last log entry is handled, and a closed relay never connects
  again (from review). `!link` lines stay chat until the bot takes link
  reports, which A8f does before issuing any code. Not tried
  against a real server or through the tunnel (A8h); nothing can be
  paired until A8f.
- **The bridge's settings, cached** (2026-11-25, last part of A8e). The
  bot answers each helper connect with the bridge's settings (server
  name, prefix, colour, default and per-player pictures), which the
  helper checks field by field and puts over its config's (the
  dashboard's win; a refused field keeps the config's), applying them at
  once to posts, the fallback sender and `tellraw`. It keeps the last
  ones in `mcbridge.settings.json` beside the config, tagged with the
  bridge's id, and reads them at startup, so posts keep their name and
  pictures while the bot is away. Not tried against a real server (A8h).
  With this, A8e is done.
- **Who reaches a server's Minecraft pages** (2026-11-25, first part of
  A8f; decision 0013). The dashboard's member fetch now answers two
  rights from one call (`dashboard/access.ts`): Manage Server (decision
  0012) and managing bridges (the server's owner or the allowed role, not
  in timeout, `canManageBridges`). The guard on `/servers/:guildId/*`
  lets in either, and each route requires its own (`requires('server')`,
  `requires('bridges')`), listed in `ROUTE_ACCESS`; a test tries every
  such route as a user holding only the other right. `/servers` lists
  servers where the user has either, linking the pages that are theirs,
  and `/servers/:guildId/minecraft` lists the paired bridges read-only
  (name, channels, and whether chat goes into the game yet). Worked out
  here: one guard with a check per route rather than a second guard on
  another prefix, which would split a server's pages and couldn't use
  `/minecraft/` (the helper's, outside the pages' rate limit). Not tried
  on the live dashboard; nothing pairs a bridge until the next part.
- **Adding a Minecraft server** (2026-11-25, second part of A8f).
  `/servers/:guildId/minecraft/new` pairs a bridge: a name, and the chat
  and alerts channels from those where the member can see and manage
  webhooks, then `pairBridge` as the member fetched fresh; the config
  for `mcbridge` is shown once, to copy. A refusal brings the form back
  with what to fix; a member who lost the right on the fresh check gets
  the guard's 404. The dashboard reaches pairing through
  `src/minecraft/dashboardPairing.ts` (`BridgePairing`), built from the
  bot's client in `index.ts`, rather than widening the dashboard's guild
  type to all of `PairingGuild`. Worked out here: the form asks Discord
  for the member rather than reusing the access check's cached answer,
  so the list names no channel they can't see (one call per form view,
  under the per-account page limit); the config is in a read-only box
  rather than a download, as the pages run no scripts and a download
  would need the secret again (a `data:` link with `download` is an
  option, not checked against browsers). The route tests now send a POST
  as the dashboard's own form does (`Origin` and a form body), as Hono's
  CSRF check otherwise answers 403 before the guard. From review: each
  form carries a one-time token (`dashboard/formTokens.ts`), used up
  before the POST pairs, so a reload or a double click can't pair twice
  (redirecting after it can't help, as the secret is in that response
  only); a refusal names a channel only from the member's own choices,
  as pairing refuses a voice channel, or one the member lacks rights in,
  before checking they can see it, which would have told an allowed-role
  member a hidden channel's name; and the form's body is capped at
  8 KiB. Not tried against Discord or on the live dashboard (A8h).
- **Who may manage Minecraft servers** (2026-11-25, third part of A8f).
  The owner alone (a third route level, `owner`, from the same member
  fetch) chooses the allowed role at `/servers/:guildId/minecraft/role`,
  or clears it; the Minecraft page names it. Offered: the server's roles
  but `@everyone` and integrations', highest first. Saving asks Discord
  afresh (`rightsIn` gains `{ fresh: true }`, skipping and replacing the
  30 s answer, decision 0012), so a former owner can't in the 30 s after
  the server changes hands, then redirects, as nothing in the answer is
  secret. Worked out here: no one-time token, as saving twice changes
  nothing; and the page warns that whoever can give the role can make
  themselves a manager. Not tried against Discord (A8h).
- **Regenerating and removing a Minecraft server** (2026-11-25, fourth
  part of A8f). Each bridge on the Minecraft page links
  `/servers/:guildId/minecraft/bridges/:bridgeId/regenerate` and
  `…/remove`, each a page that asks first (the pages run no scripts to
  confirm with). Regenerating (`regenerateBridge`, now offered) shows the
  new config once, behind a one-time token as pairing's is, and names
  any old webhook Discord kept, as it still posts. Removing
  (`removeBridge`, new) deletes the row with its links and pictures,
  then both webhooks by token, and goes back to the list. Both go
  through `BridgePairing` as the member fetched fresh, and end the
  helper's session at once (`HelperHub.end`): a poll held with the old
  keys would otherwise get chat for up to 50 s more, which matters for a
  leaked config. Worked out here: remove needs no token (nothing secret
  in its answer, and a second finds nothing) and doesn't check the
  member's rights in the channels, as it hands over no webhook URL and a
  manager must be able to remove a bridge whose channel they can no
  longer see. A bridge's own page, with its name, prefix, colour and
  default picture, comes next. Not tried against Discord (A8h).
- **A Minecraft server's settings** (2026-11-25, fifth part of A8f).
  `/servers/:guildId/minecraft/bridges/:bridgeId`, linked from each
  bridge on the Minecraft page, changes its name, prefix, colour and
  default picture (generated, skin, none, or the helper's config's).
  `checkSettingsChange` (`minecraft/bridgeSettings.ts`) checks each field
  by the helper's own rules (`serverNameProblem`, `isPrefix`,
  `isColour`), as the helper drops a field it would refuse, and a test
  passes what it saves through the helper's `readSettings`; a refusal
  names every field to fix. Saving asks Discord afresh, then queues the
  settings on the hub, so a connected helper applies them at once rather
  than at its next connect; this is the "settings message when the
  dashboard changes them" for these four fields. Worked out here: no
  one-time token (saving twice changes nothing) and a redirect after
  saving; hex colours are lowercased, as named ones must be. From
  review: the settings are held on the hub for as long as a session can
  live without polling (110 s), not chat's 30 s, so a helper backing off
  still gets them, and a full queue is logged. Not tried
  against Discord or a real helper (A8h).
- **Pictures for particular players** (2026-11-25, sixth part of A8f).
  A bridge's settings page lists the pictures set for players, each with
  a button to remove it, and sets one by Minecraft name (generated by
  name or by number, skin, none) through
  `POST …/bridges/:bridgeId/pictures`. `checkPictureChange`
  (`minecraft/bridgeSettings.ts`) uses the helper's own checks, now
  exported from `bridge/settings.ts` (`isPlayerName`,
  `isSettingsPicture`), and a test passes what it saves through the
  helper's `readSettings`. Saving asks Discord afresh and queues the
  settings on the hub, as the settings form does. From the last part's
  review: a bridge has pictures for at most 100 players
  (`MAX_PICTURES_PER_BRIDGE`, about 5 KB in every connect answer);
  past that `setPlayerPicture` refuses a new name but still changes one
  it has. Worked out here: its own form and route rather than rows in
  the settings form, so each refusal is about one player, and an empty
  picture removes one, as an empty default hands it to the config. Not
  tried against Discord or a real helper (A8h).
- **Members' links on a Minecraft server's page** (2026-11-25, seventh
  part of A8f). A bridge's settings page lists its links (player, the
  member, their user id, the day they linked), each with a button that
  removes it through `POST …/bridges/:bridgeId/links/remove`, asking
  Discord afresh. Worked out here: the member is named from the bot's
  member cache (filled by their messages and commands, checked in
  discord.js 14.27's `Message.js`; emptied on a restart), with the id
  always shown, rather than a fetch per link on every page view, which
  would wait on Discord's rate limit with links uncapped, or a name
  stored at linking, which goes stale; no token or page that asks
  first, as removing twice finds nothing and the player can link again;
  and nothing is sent to the helper, as nothing sends it linked
  players' pictures yet (once something does, removing must tell it).
  Nothing creates links yet, so the list stays empty until linking. Not
  tried against Discord or on the live dashboard (A8h).
- **`!link` reports** (2026-11-25, first part of linking, A8f). The bot
  takes a helper's report of a player's `!link` line at a third sealed
  route, `POST /minecraft/link`, and answers with the text the helper
  shows that player alone. `LinkCodes` (`minecraft/linking.ts`, memory
  only, as the plan has it) gives six-digit codes per bridge, name
  (without case) and member, each for 10 minutes and used once; every
  code for a name is voided after 5 wrong ones. `answerLinkReport`
  refuses an offline-mode server before looking at the code, asks a
  player whose login line the helper missed to log in again (keeping the
  code), refuses a UUID that isn't Mojang's, and saves the link with the
  log's spelling of the name. Worked out here: a member asking for a code
  replaces only their own for that name, not another member's, so asking
  can't void someone else's, and two members never hold the same code for
  one name, so a right code names who linked; the report needs no
  session, as the seal proves the bridge, and counts against its rate
  limit like any request; and the bot writes the player's answer rather
  than the helper, so its wording changes with a deploy instead of with
  every host's helper. From review: a UUID is kept in the log's form,
  lowercase with dashes, as a link is compared with the login's UUID as a
  string; and a wrong code counts for the name until its codes are voided,
  even if a member asks for a new one, so asking gives no more guesses.
  Whatever gives codes must limit how often a member asks, as `LinkCodes`
  caps nothing. Nothing gives codes yet and the helper doesn't
  report yet (next), so nothing changes for users.
- **The helper reporting `!link` lines** (2026-11-25, second part of
  linking, A8f). Once paired, `main.ts` gives `bridge.ts` its `link`
  option, so a `!link` line no longer reaches Discord: `linkReports.ts`
  sends a well-formed one through `botClient.ts`'s new `report` and shows
  that player alone the bot's answer through `gameRelay.ts`'s new `tell`
  (`privateCommand` in `toMinecraft.ts`, `tellraw <player>`, sharing
  chat's cleaning, escaping and cut). Worked out here: a report goes
  beside the poll loop, not through it, so it never waits on a held poll,
  with a 15 s timeout; it waits out a 429, as reports share the bridge's
  limit with polls (from the last part's review), corrects for its clock
  once, and backs off only while nothing takes the connection, its last
  try ending within a minute, as the player is waiting. From review:
  anything the bot may have acted on (a timeout, an error page, its own
  refusal) isn't sent again, as the bot's check isn't idempotent (a
  right code sent twice would be told "no code waiting", a wrong one
  would count twice towards voiding); a helper the bot stopped taking
  (taken over, or a 401) sends nothing, as a newer copy reports, and
  tells the player the server's mcbridge needs its owner; and a helper
  shutting down says nothing. Otherwise, without an answer the helper
  shows its own line ("couldn't check your code … try again in a few
  minutes"); those two are its only wording. A lost answer is logged
  under the player's name, not counted as chat. The answer goes
  in turn with chat but past chat's cap of 50, as there's one per line
  the bot took and the player is waiting; only a name Minecraft allows
  (`[A-Za-z0-9_]{1,16}`) is a target, so nothing can aim it at `@a`.
  Nothing gives codes yet, so a player typing `!link` is told there's no
  code waiting. Not tried against a real server (A8h).
- **My Minecraft accounts** (2026-11-25, third part of linking, A8f).
  `/servers/:guildId/minecraft/accounts`, for any member, lists their
  own links on that server's bridges with an Unlink button
  (`deleteOwnLink`, only theirs), and gives a code for a bridge and
  Minecraft name, shown once. A fourth access level, `member`, as
  decision 0013's Consequences foresaw, recorded in decision 0014
  (superseding 0013 in part): the guard on `/servers/:guildId/*`
  now lets in any member, each route requires its own right, and the
  deny-by-default test also tries every server, bridges and owner route
  as a member with no right. Worked out here: a code is answered with the
  page rather than a redirect, as it's shown once, and needs no token, as
  asking again only replaces the member's code for that name; one account
  gets at most 5 codes per 10 minutes across servers, as `LinkCodes` caps
  nothing (from the first part's review); both forms ask Discord afresh
  (decision 0012); and the server list shows a server where the user is
  only a member when it has a Minecraft server, linking this page alone.
  Members in timeout can link, as it's about themselves; managing still
  excludes them. A helper not yet updated posts a typed `!link` line to
  Discord as chat, which shows the code there, but only that player can
  use it, as the bot checks the code against the name typing it.
  Choosing a linked name's picture comes next. Not tried against Discord
  or a real server (A8h).

## Next up

Feature work, in this order unless the owner says otherwise. Schema
changes are cheapest now, while the bot is pre-release (decision 0003).

Items 1 to 4 are designed in
[`plans/minecraft-ff14-features.md`](plans/minecraft-ff14-features.md),
which has their PR order (its "Suggested pull request order"), the inputs
to ask the owner for, and which facts are still unverified. The owner put
them ahead of items 5 and 6.

1. **Minecraft bridge, what's left** ([Track A](plans/minecraft-ff14-features.md#track-a-minecraft-bridge)).
   The first version, crash reports and player avatars are done and tested
   end to end (Done above). Left: Discord to Minecraft chat, designed in
   [A8](plans/minecraft-ff14-features.md#discord-to-minecraft-chat-a8)
   with decisions 0006 and 0007. It goes through the bot and is set up in
   the dashboard, and players in the Discord server choose their picture
   there (or with `/minecraft link` and `/minecraft avatar`) after linking their account by a
   code typed in game. That replaces choosing in game (`!avatar`), the
   owner's call (2026-11-21). Its helper-side parts A8a to A8c (the RCON
   client, the `tellraw` builder and `server.properties` reader, and the
   `!link` line) are done; the rest follows item 2.
2. **Dashboard foundation, then two-way Minecraft chat**
   ([Track D](plans/minecraft-ff14-features.md#track-d-web-dashboard)
   D0 and D1, moved up by the owner on 2026-11-22, with the rest of the
   Minecraft work, ahead of the collection tracker). The hostname and
   HTTPS, Discord login, and a read-only reminders page. D0 is done:
   decisions 0008 and 0009 (Done above). The domain is on Cloudflare and
   the tunnel exists (2026-11-23, asking for no payment method). D1 is
   done (Done above): the web server through the tunnel, login with
   Discord, the server list guarded per server, the read-only reminders
   page and rate limits, all tried on the live dashboard. Left: A8e to
   A8i, two-way chat, linking and pictures. A8d (the bot's storage,
   sealing, endpoint, pairing and dropping the links of members who
   left) is done (Done above); the relay (A8e) is under way: the bot
   reads bridge chat channels, announces the relay and catches up after
   a restart, the helper puts chat into the game, and it keeps the
   bridge's settings (Done above): A8e is done. A8f is under way: who
   reaches a server's Minecraft pages, a list of its bridges, adding
   one, who may manage them, regenerating and removing one, its
   settings, pictures for particular players, members' links on a
   bridge's page, the bot taking `!link` reports, the helper sending
   them, and My Minecraft accounts (Done above). Next: choosing a linked
   name's picture there (with previews), `/minecraft link`,
   `/minecraft avatar`, and sending linked players' pictures to the
   helper.
3. **Collection tracker (`/collection`, `/collectionadmin`)**
   ([Track B](plans/minecraft-ff14-features.md#track-b-collection-tracker)).
   Per-server collections (FF14 mounts first), imported once from the
   group's spreadsheet.
4. **Lodestone news and scheduled events**
   ([Track C](plans/minecraft-ff14-features.md#track-c-lodestone-news-and-scheduled-events)),
   then the **role check-in** after onboarding
   ([Track E, E2](plans/minecraft-ff14-features.md#e-role-check-in-after-choosing-a-role)),
   which needs the Server Members Intent switched on first.
5. **File or audio attachments on reminders** (bundled sounds or user
   uploads). Open questions first: where uploads live (the VM's disk, or
   Discord's own CDN by re-posting the attachment URL, which expires),
   size limits, and the free tier. Likely a design note or decision record
   before code.
6. **Rework `/remindme`** (brainstorm in its own session first). One
   command does everything through optional options: view (no options),
   update (`enabled`, `interval`, `message`, `embed`), snooze, and `reset`,
   with rules about which combine. Options to weigh include subcommands
   like `/reminder`'s, or a wider rework. A known bug to fix on the way:
   the update reply repeats the whole message, so one near the 2000
   character limit pushes the reply past Discord's 2000, and the user sees
   an error although the settings were saved. Command names and options
   are what users depend on, so a new shape is cheapest now, while the bot
   is pre-release.

## Later (candidates, unordered)

New tooling waits for a real bug or real friction (CLAUDE.md), and a
runtime dependency is the owner's decision.

- Two pairings of one server at once (two members, or two browser tabs
  each with its own form) both pass `pairBridge`'s limit check before
  their webhooks' `await`, so a server can pass its 10 bridges by a few.
  Re-checking the count inside `createBridge`'s insert would close it
  (from A8f's second part's review, 2026-11-25).
- End the pre-release phase (decision 0003) before the first bridge is
  paired in a server the owner doesn't run: a reset would then delete
  other people's webhooks, keys and links. The owner's call; from
  reviewing the decisions' consequences (2026-11-23).
- A startup schema check: after migrations, query each table once (or
  compare its columns with the row interfaces), so a decision 0003 reset
  deployed without deleting the database, or any drift, makes the bot
  exit and the deploy's login check fail, instead of the first query
  failing later while the bot looks healthy (decisions 0002 and 0003).
- `npm run deploycommands` opens `bot.db` (the command files import
  storage, so `core/database.ts`), and the deploy runs it right after
  restarting the bot: on a deploy with a migration, both race to migrate
  and to snapshot first, and the loser fails (a duplicate column, or
  busy). Registering commands shouldn't need the database (from review
  of the VM snapshots, 2026-11-23).
- `__resetForTests` clears every table SQLite lists (`sqlite_master`,
  leaving out its internal `sqlite_%` tables) instead of a hand-kept
  list, so a new table can't be missed and leak state between tests
  (decision 0004).
- An alert from `mcbridge` when the server has started but no line is
  recognised for a long while, so a Minecraft update that changes the
  log's format doesn't silently stop the bridge (decision 0005).
- Minecraft data for servers the bot was removed from while offline:
  `GuildDelete` never arrives for them (a deploy's seconds, or an
  outage), so their bridges, links and keys stay in `bot.db`. When the
  bot is ready, it could delete the rows of servers not in its guild
  cache, once it's checked that every server it's in is in the cache
  then, unavailable ones included (from A8d's storage PR, 2026-11-24).
- An ESLint rule letting only `storage.ts` files import `db`, if an area
  is ever found querying another's tables (decision 0004; new tooling,
  so only for a real case).
- Tidy the schema while pre-release, when a feature touches it:
  `guild_settings` has no row until `/reminder master` is used, which is
  why the due query needs the `LEFT JOIN` with `NULL` handling; and
  `last_sent_at = 0` stands for "never sent".
- The status embed after a snooze ends: it's rebuilt only when a reminder
  sends or a command changes something, so its 💤 label can stay until
  the next send (the time it shows stays correct). Same staleness as "due
  on next check" already has.
- A snooze with "wait a full interval" set while that reminder's send is
  in flight: recording the send overwrites the snooze's `last_sent_at`, so
  it sends when the snooze ends instead of an interval later (comment in
  `src/reminders/storage.ts`). Fix with `MAX(last_sent_at, ?)` in the send records if it
  ever matters.
- A minimum coverage threshold in CI (Vitest's `coverage.thresholds`), and
  the HTML coverage report as a CI artifact.
- Structured logging (for example `pino`) with levels, in place of
  `console.log`/`console.error`. A runtime dependency.
- A `CHANGELOG.md`. The squash-merged history with conventional titles
  covers it while there are no users or releases.
- Dependabot version updates (`.github/dependabot.yml`); security updates
  are already on.
- The rest of the web dashboard (D2 onwards: editing reminders, Lodestone
  and collections), after the tracks in Next up:
  [Track D](plans/minecraft-ff14-features.md#track-d-web-dashboard)
  says why it waits and what it needs (its libraries being the owner's
  decision). Before D2, from reviewing decision 0012's consequences
  (2026-11-24): anything that changes data checks access with Discord
  fresh, skipping the 30 s cache, so a demoted moderator can't edit in
  that window; and decide whether the dashboard should follow a
  server's command permissions (Server Settings → Integrations) rather
  than Manage Server alone, so moderators given `/reminder` without
  Manage Server can use it too (readable through Discord's API with
  the bot's token).
- Custom emoji limited to certain roles: the warning doesn't check
  whether the bot has one of the emoji's roles, so such an emoji can still
  show as text unwarned.
- Bot-owned application emoji (usable anywhere, no Use External Emojis
  needed), for example for bundled reminder icons.
