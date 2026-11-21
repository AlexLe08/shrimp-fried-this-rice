# Plan: refactor before the feature tracks

A review of `src/` and `test/` on 2026-11-20 (`main` as of #29), done before the feature tracks in [`minecraft-ff14-features.md`](minecraft-ff14-features.md) start. It found duplicated code to move into shared helpers, a 600-line command to split, and a flat `src/` that would mix reminder, FF14 and Minecraft code. This file is the work, divided into tasks of one session and one PR each, in order.

How to work through it:

- CLAUDE.md's workflow applies to every task: a worktree per PR (`scripts/new-worktree.sh`), `scripts/check.sh`, the `reviewer` agent, a Deploys line, and squash-merged PRs titled like a commit subject.
- **No behaviour change.** Command names, options, replies and what the scheduler sends stay exactly as they are. Task 1's snapshot test proves the command definitions don't change; the existing tests prove the rest. A test whose expected values would have to change means the refactor changed behaviour: stop and report it (CLAUDE.md's rule on tests).
- Each task is a refactor, so it adds no roadmap Done entry until the last one, which adds one for the series and removes the roadmap's Next up item.
- If a task turns out wrong or a simpler shape fits better, say so and update this file in the same PR.
- Mark each task done here (strike it through, with its PR number) in its own PR.

## Decisions already made by the owner (2026-11-20)

- **Feature folders.** `src/<area>/` holds an area's commands, storage, checks and embeds; the command and event loaders scan `src/*/commands/` and `src/*/events/`. The alternative, keeping `src/commands/<area>/` with the logic in `src/<area>/`, needs no loader change but splits every feature across two folders.
- **Areas:** `core/` (bot plumbing and Discord helpers any area may use), `reminders/`, `ffxiv/`, `minecraft/`. `ffxiv/` takes everything in Tracks B, C and E, the role check-in (E2) included for now, although it isn't FF14-specific. The folder uses `ffxiv`, the game's official abbreviation; the docs' prose still says FF14.
- **Decision record 0004 (feature storage modules) moves here**, to task 3, from E1. E1 then follows it instead of adding it.
- **Limits live with their area**: `MIN_INTERVAL_MINUTES`, `MAX_INTERVAL_MINUTES` and `MAX_REMINDERS_PER_GUILD` move to `src/reminders/`, and later caps (collections, open recruits) to their own area's storage module. This changes what the feature plan said (limits in `storage.ts`).

## Constraint: the entry points stay where they are

The VM's systemd unit starts the bot with `ExecStart=/usr/bin/node ./src/index.ts` (`ORACLE_CLOUD_DEPLOYMENT.md`). That file is on the VM, not in the repo, so a merge that moved `src/index.ts` would restart the service into a missing file: the deploy fails after its 60-second login wait and the bot stays down until someone edits the unit over `ssh`. `src/index.ts` and `src/deploy-commands.ts` (run by `npm run deploycommands`) stay at the top of `src/`; everything else may move.

## Target layout

```
src/
  index.ts                 # stays (systemd)
  deploy-commands.ts       # stays (npm run deploycommands)
  core/
    loadCommands.ts        # task 2: the one command loader, used by both entry points
    database.ts            # task 3: the handle, CREATE TABLEs, MIGRATIONS, closeDatabase, __resetForTests
    discord.ts             # task 4: ephemeral reply, discordTime, message limit, fitting lines under it, error codes, CODE
    scheduler.ts           # task 6: runs a list of named checks
    customEmoji.ts
    eventListener.ts
    shutdown.ts
    events/                # interactionCreate.ts, ready.ts
    types/                 # command.ts, types.d.ts
  reminders/
    commands/              # reminder.ts (renamed from guildreminder.ts, as the command is /reminder), remindme.ts
    subcommands/           # task 5: one handler per /reminder subcommand (not under commands/: every .ts there is loaded as a command)
    storage.ts             # task 3: reminder queries, row interfaces, limits
    dueReminders.ts        # task 6: the guild and DM checks
    statusEmbed.ts         # renamed from reminderEmbed.ts: it is the /reminder status embed
    reminderMessage.ts
    snooze.ts
  ffxiv/                   # created by E1: recruit, collections (B), Lodestone (C, the plan's src/news/), role check-in (E2, its member events in ffxiv/events/)
  minecraft/               # created by A: the plan's src/mcbridge/ becomes src/minecraft/bridge/
test/                      # mirrors src/
```

Empty folders aren't tracked by git, so `ffxiv/` and `minecraft/` are created by the first PR of their track, not here.

## Tasks

### ~~1. Snapshot the registered commands~~ (done, #31)

- Branch `test/snapshot-command-definitions`; PR `test: snapshot every command's registered definition`.
- A test that loads each command and matches `data.toJSON()` against a Vitest snapshot (`toMatchSnapshot`, stored in `test/__snapshots__/`). A refactor that changes a name, option, description, choice or permission then fails it. Tasks 2 and 5 rely on it.
- As built: `test/deployCommands.test.ts` snapshots the body `deploy-commands.ts` sends (mocked `REST`), sorted by name and passed through JSON as REST sends it, rather than loading the command files itself. It needs no third copy of the loader, and task 2 can move the commands and replace the loader without touching the test, since `deploy-commands.ts` stays put. One snapshot of the whole list, so a dropped command fails it (a per-command snapshot would only turn obsolete).
- Deploys: no runtime change.

### ~~2. Feature-folder layout and one command loader~~ (done, #32)

- Branch `refactor/feature-folders`; PR `refactor: move src into core and reminders feature folders`.
- `git mv` everything to the target layout, except what tasks 3 to 6 create. Two files wait for their own task: `src/storage.ts` stays where it is until task 3 splits it (its default database path is relative to its own folder, see task 3), and `scheduler.ts` goes to `src/reminders/scheduler.ts` until task 6 splits it. Keep moves and edits apart (a commit of pure moves, then the import fixes) so the diff shows renames.
- `src/core/loadCommands.ts`: the command loop `index.ts` and `deploy-commands.ts` each copy today (the copies have drifted: one imports a path, the other a file URL), scanning `src/*/commands/*.ts`. `index.ts` loads events from `src/*/events/*.ts`.
- Tests move to mirror `src/`. Task 1's snapshot must pass unchanged.
- Update: CLAUDE.md's Architecture rules (commands live in `src/<area>/commands/`, `snooze.ts` and `reminderEmbed.ts` paths), README's file trees and paths, `ORACLE_CLOUD_DEPLOYMENT.md` (`src/events/ready.ts`), `vitest.config.ts`'s coverage `exclude`, and the feature plan's paths (`src/news/` → `src/ffxiv/lodestone/`, `src/mcbridge/` → `src/minecraft/bridge/`, `src/events/` for E2 → `src/ffxiv/events/`, and Track A's reason the bot never loads the bridge: it has no `commands/` or `events/` folder).
- As built: `loadCommands.ts` also exports `findAreaModules('commands' | 'events')`, the file scan both loaders share (sorted, as file URLs), which `index.ts` uses for events; a new `test/core/loadCommands.test.ts` pins the files it finds, as `index.ts` has no test. `test/storage/` stays until task 3. The feature plan's `src/newsStorage.ts` is left for task 3, with the other storage references. CLAUDE.md gains a rule on the area layout and why the entry points stay.
- Deploys: no user-visible change; the deploy re-registers the same command set (task 1's snapshot) and `src/index.ts` is where systemd expects it.

### ~~3. Storage split and decision record 0004~~ (done, #33)

- Branch `refactor/feature-storage-modules`; PR `refactor: split storage into core/database.ts and reminders/storage.ts`.
- `src/core/database.ts` opens the database and exports the handle, and keeps every table's `CREATE TABLE`, `MIGRATIONS` (one sequence for all areas: `user_version` is a single number), `closeDatabase` and `__resetForTests`. `src/reminders/storage.ts` takes the reminder queries, their row interfaces and the limits. The SQL doesn't change.
- **The default database path is chosen on purpose, not moved by accident.** `src/storage.ts` builds it from its own folder (`path.join(__dirname, '..', 'reminders.db')`); copied unchanged into `src/core/`, it would point at `src/reminders.db`, and production would quietly open a new, empty database, with no error: the tests never use the default (`DB_PATH=':memory:'`), the deploy's login check still passes, and `.gitignore`'s `*.db*` hides the stray file. So `core/database.ts` resolves the default from the project root, in a small exported function, and a new test checks what it returns with `DB_PATH` unset. That test opens no database, so the in-memory test database isn't in the way.
- **The owner allows the path to change** (2026-11-20; pre-release, no users). Recommended: keep `reminders.db` in the project root, as no gain was found in moving it. If the session finds one (a `data/` folder, say), it may move it. Then production starts with an empty database, as a decision 0003 reset does; the old `reminders.db` (and its `-wal`/`-shm` files) stays in the project root until the owner deletes it; `better-sqlite3` won't create a missing folder, so the code must; and README's and `ORACLE_CLOUD_DEPLOYMENT.md`'s mentions of `reminders.db` change with it.
- While moving: `isGuildMasterEnabled(guildId)` replaces the `settings ? settings.master_enabled === 1 : true` copied in `/reminder list` and the status embed; `updateGuildReminder` returns the updated row, so `/reminder edit` doesn't read it again.
- Decision record 0004 (from `docs/decisions/0000-template.md`, indexed in its README): Context and Consequences drafted from the feature plan's "Feature storage modules" and this plan; **Why left as `TODO(Alex)`**. It names `core/database.ts` as the one module that opens SQLite and owns the schema, and each area's storage module as the only code in that area that queries it.
- Update CLAUDE.md's "`src/storage.ts` is the only module that touches SQLite" rule to match, including its pre-release reset sentence (decision 0003 rewrites the `CREATE TABLE`s, now in `core/database.ts`). Update every `storage.ts` reference in the feature plan: migrations go in `core/database.ts`, and caps (collections, open recruits) in the area's own storage module. Decisions 0002 and 0003 are left as written: they record where the schema was when they were made.
- As built: the file stays in the project root but is renamed `bot.db`, at the owner's request (2026-11-20), since it now holds every area's tables. The rename resets production, as above (no folder, so no code to create one). The path is resolved by `databasePath()` in `core/database.ts`, pinned by `test/core/database/databasePath.test.ts` (checked to fail with the path copied unchanged). The tests moved to `test/core/database/` (closing, migrations, the path) and `test/reminders/storage/`; their only edits are imports, `__resetForTests` and `closeDatabase` now coming from `core/database.ts`. Decision 0004 lets an area with several features (`ffxiv/`) have a storage module per feature (`src/ffxiv/recruit/storage.ts`), which the feature plan now names. The `reviewer` agent's checklist and `CASESTUDY.md` follow the new rule.
- Deploys: no runtime change in behaviour; migrations and tables are untouched. If the path stays, ask the owner to check after the deploy that the bot still has its reminders (`/reminder list` on a server that had some), i.e. that it opened the existing database. If it moves, say that production's reminders and settings start empty, and ask the owner to delete the old `reminders.db` files from the VM when convenient.

### ~~4. Shared Discord helpers in `core/discord.ts`~~ (done, #34)

- Branch `refactor/shared-discord-helpers`; PR `refactor: share reply, time and message-length helpers`.
- `replyEphemeral(interaction, content)` for every ephemeral `reply` (about 28: 20 in `/reminder`, 6 in `/remindme`, 2 in `interactionCreate.ts`).
- `discordTime` moves from `snooze.ts`; `statusEmbed.ts` and `interactionCreate.ts`'s cooldown reply use it instead of building `<t:…:R>` by hand.
- One `DISCORD_MESSAGE_LIMIT` (two `MESSAGE_LIMIT = 2000` today) and one "add lines until the limit, then say how many were left out" function for `fitList` (`/reminder list`), `customEmoji.ts`'s `fit` and `reminderMessage.ts`'s `mentionsOutsideEmbed`. `fitTo` (cutting text on whole characters) moves here too.
- Discord error codes from discord.js's `RESTJSONErrorCodes` (exported by the installed 14.27.0, checked 2026-11-20) instead of `10003`/`10008` literals, and `isRefusedByDiscord` from `scheduler.ts`.
- The `CODE` regex moves out of `reminderMessage.ts`, which `customEmoji.ts` imports it from today.
- New tests for each helper; existing callers' tests unchanged.
- As built: the one fitting function is `fitLines(lines, limit, { separator, more })`, returning as many lines as fit with the `more(left out)` text counted towards the limit (`fitList` passes the limit minus its header). Two edge cases now behave alike where the copies differed. First, the emoji warning's "…and N more warnings" line used to sit outside its 1000-character budget and now counts towards it; the longest possible first line is 930 characters (a 100-character server name of `|`, `~` or `\`, each escaped), 964 with that suffix, so the first line still always fits. Second, the cooldown reply's timestamp is rounded down to the second, as every other `discordTime` is, instead of to the nearest one: a relative "in N seconds" can't show the difference. Error codes use `RESTJSONErrorCodes` from discord.js directly; no wrapper was needed. `deferReply` and the error fallback's `followUp` keep their own flags (task 7 tidies the latter).
- Deploys: no runtime change.

### ~~5. `/reminder`: one handler per subcommand~~ (done, #35)

- Branch `refactor/reminder-subcommands`; PR `refactor: split /reminder into one handler per subcommand`. If it grows past a comfortable review, make it two PRs: the helpers, then the split.
- `execute` dispatches from a table of subcommand handlers in `src/reminders/subcommands/` instead of a 300-line `if` chain.
- A "find the reminder or reply 'No reminder found'" helper for the five subcommands that repeat it (with the lowercased `label`).
- Shared option builders: the `label` option with autocomplete (five copies), and `interval`, `message` and `embed`, which `/remindme` also uses. The after-snooze option's description moves to `snooze.ts` (copied in both commands today).
- `getChannel('channel', required, [ChannelType.GuildText])` (`true` in `create`, `false` in `edit`), which narrows the type in discord.js 14.27.0 (checked 2026-11-20), replaces the two `as TextChannel` casts on the option. The other two cast `guild.channels.cache.get(...)` for the saved channel; replace them with a type check, or leave them. `/reminder edit` reads the channel's permissions once for both warnings.
- One function for a reminder's `` • `label` — every Nm in <#channel> `` line, used by `/reminder list` and the status embed.
- Replacing the status message (delete the old one, post, save) moves from the `status` subcommand into `statusEmbed.ts`, which owns that message everywhere else.
- `/remindme` only switches to the shared helpers and option builders: the roadmap's "Rework `/remindme`" item rewrites it, so restructuring it now would be thrown away.
- As built: one PR. Each file in `src/reminders/subcommands/` default-exports `{ name, build, execute }` (`ReminderSubcommand`), so a subcommand's options sit beside its handler; `reminder.ts` builds `data` from its `SUBCOMMANDS` list, in the registered order, and routes by name. A new `test/reminders/subcommands/registered.test.ts` fails when a file there is missing from that list, which the snapshot can't catch (checked by dropping `status`). The helpers (`findReminder`, `labelOf`, `botPermissionsIn`, the two warnings, `joinWarnings`) are in `subcommands/helpers.ts`; the option builders, and `EMBED_OPTION_DESCRIPTION` from `reminderMessage.ts`, in `src/reminders/options.ts`; `AFTER_SNOOZE_DESCRIPTION` in `snooze.ts`; `reminderSummary` and `replaceGuildStatusMessage` in `statusEmbed.ts`, whose `StatusMessageClient` now includes the message's `delete`. The saved channel's casts went by typing the warnings' parameter as `GuildBasedChannel` (all they call is `permissionsFor`), not by a runtime type check, which would have changed what the fakes in the tests get. `/reminder edit` reads permissions only when a warning is checked, as before: reading them on every edit failed three tests, whose fake guild has no channel cache.
- Deploys: no user-visible change (task 1's snapshot, and the command tests unchanged).

### ~~6. Scheduler: a list of named checks~~ (done, #36)

- Branch `refactor/scheduler-checks`; PR `refactor: run the scheduler's checks from a list`.
- `src/core/scheduler.ts` keeps the timer, the no-overlap guard per check, `runCheck`'s logging and `stopScheduler` waiting for running checks, over a list of `{ name, run }` instead of the hand-written `guildCheck` and `userCheck`. The reminder checks move to `src/reminders/dueReminders.ts`; `ready.ts` passes the list. E1 and E2 then add a check by adding to the list.
- The embed-or-plain-text choice, made separately for server and DM sends today, moves into one function beside `buildReminderMessage`.
- Not yet: a general poller for Lodestone (C2). Build it when C2 needs one, from this.
- Update the feature plan's references to `src/scheduler.ts` (Track C's polling, Track E's due checks) to the list of checks.
- Tests keep going through `startScheduler` with fake timers (CLAUDE.md).
- As built: a check is `ScheduledCheck` (`{ name, run(signal) }`), and the scheduler takes only the list, `startScheduler(checks)`: each check closes over the client it needs, so `core/` holds no area's client type (`SchedulerClient` stays with the reminder checks). `stopScheduler` aborts an `AbortSignal` instead of setting the module's `stopping` flag, and the overlap guard is a map from check to its running promise. `dueReminderChecks(client)` returns the two reminder checks, named `Guild reminder` and `DM reminder` so the failure log lines are unchanged; `ready.ts` calls `startScheduler(dueReminderChecks(client))`. The embed-or-plain-text choice is `reminderContent` in `reminderMessage.ts`. The scheduler's tests moved with the checks to `test/reminders/dueReminders.test.ts` and `dueRemindersCheckFailure.test.ts`, their only edits the imports and `startScheduler(dueReminderChecks(client))`; `test/core/events/ready.test.ts` now expects `startScheduler` to get `dueReminderChecks(client)`'s list instead of the client. A new `test/core/scheduler.test.ts` runs the loop with fake checks and covers the overlap guard, which README had listed as untested (checked to fail with the guard removed).
- Deploys: no behaviour change; shutdown still waits for a send under way.

### 7. Interaction and event plumbing

- Branch `refactor/interaction-plumbing`; PR `refactor: tidy interaction routing and event loading`.
- `interactionCreate.ts`: look the command up once, one fallback error reply instead of two copies (`followUp` or `reply`), the cooldown as its own function. C4's button routing goes in after this.
- An `Event` type in `core/types/` for event modules (`index.ts` types them inline today).
- `import.meta.dirname` (in Node since 20.11, so in the Node 24 of `.nvmrc`) instead of the `fileURLToPath(import.meta.url)` lines in `core/loadCommands.ts` and `core/database.ts` (task 2 removed the ones in `index.ts` and `deploy-commands.ts`). The database path keeps resolving to the project root (task 3's test).
- `customEmoji.ts` takes a narrow client interface (what it reads: `emojis.cache`) instead of all of `Client`, as #28 did for the scheduler and status embed.
- Deploys: no behaviour change.

### 8. Test helpers

- Branch `test/shared-test-helpers`; PR `test: share guild, channel and reply fakes`.
- `createMockGuild` for the three `makeGuild`s (different shapes today), the permissive and restricted channel fakes, and `replyContent`, in `test/mocks.ts` and `test/mockInteraction.ts`. Remove the unused `inGuild`, `member` and `getUser` from the interaction fake.
- Not changed: any test's expected values.
- For the owner: the roadmap's Later item "Type-check `test/` in CI" has a real reason now (this series renames every import, and Vitest strips types unchecked). It's new tooling, so it's the owner's call whether to do it here or as its own PR.
- Last task: adds the roadmap Done entry for the series and removes the refactor's Next up item.
- Deploys: no runtime change.
