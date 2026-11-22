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
  It logs in, runs a command with a 5 s timeout, reconnects after a drop
  (1 s, doubling to 60 s), and stays off after a wrong password, with one
  callback for the alert. A command cut off by a dropped connection is
  retried once; one that timed out isn't, as a lagging server still runs
  it and a retry would show it twice. Commands must be printable ASCII
  within the wiki's 1446 bytes. Tested against a fake RCON server; not
  yet tried against a real Minecraft server (A8h measures the real
  command limit).

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
   client, done, the `tellraw` builder and `server.properties` reader, the
   `!link` line) go ahead now; the rest follows item 2.
2. **Dashboard foundation, then two-way Minecraft chat**
   ([Track D](plans/minecraft-ff14-features.md#track-d-web-dashboard)
   D0 and D1, moved up by the owner on 2026-11-22, with the rest of the
   Minecraft work, ahead of the collection tracker). The hostname and
   HTTPS on free tiers only, Discord login, and a read-only reminders
   page, each D0 choice a decision record first. Then A8d to A8i: two-way
   chat, linking and pictures.
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
  decision).
- Custom emoji limited to certain roles: the warning doesn't check
  whether the bot has one of the emoji's roles, so such an emoji can still
  show as text unwarned.
- Bot-owned application emoji (usable anywhere, no Use External Emojis
  needed), for example for bundled reminder icons.
