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
- **Embed or plain text, per reminder** (2026-11-20). An `embed` option on
  `/reminder create`, `/reminder edit` and `/remindme`; off sends plain
  text, as before #23. Migration 1 adds `embed` (default 1) to
  `guild_reminders` and `user_settings`, so existing reminders stay
  embeds. `/reminder list` and the `/remindme` view show the choice.

## Next up

Feature work, in this order unless the owner says otherwise. Schema
changes are cheapest now, while the bot is pre-release (decision 0003).

1. **Custom server emoji in reminder messages.** Discord's slash-command
   inputs don't always turn a picked custom emoji into its `<:name:id>`
   form, so it posts as text; Unicode emoji are fine. A Discord client
   limitation, so this is a workaround: for example, turning `:name:` in
   the message into the server's emoji when the reminder is saved.
   Investigate before choosing.
2. **File or audio attachments on reminders** (bundled sounds or user
   uploads). Open questions first: where uploads live (the VM's disk, or
   Discord's own CDN by re-posting the attachment URL, which expires),
   size limits, and the free tier. Likely a design note or decision record
   before code.

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
  `storage.ts`). Fix with `MAX(last_sent_at, ?)` in the send records if it
  ever matters.
- Narrow `refreshGuildStatusMessage`'s and `startScheduler`'s `Client`
  parameter to a small interface of what they use (`channels.fetch`,
  `users.fetch`, `guilds.fetch`), so the test fakes need no
  `as unknown as Client` cast.
- A minimum coverage threshold in CI (Vitest's `coverage.thresholds`), and
  the HTML coverage report as a CI artifact.
- Structured logging (for example `pino`) with levels, in place of
  `console.log`/`console.error`. A runtime dependency.
- A `CHANGELOG.md`. The squash-merged history with conventional titles
  covers it while there are no users or releases.
- Dependabot version updates (`.github/dependabot.yml`); security updates
  are already on.
- A web dashboard for configuration (longer term).
