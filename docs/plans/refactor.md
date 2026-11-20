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
- **Areas:** `core/` (bot plumbing and Discord helpers any area may use), `reminders/`, `ff14/`, `minecraft/`. `ff14/` takes everything in Tracks B, C and E, the role check-in (E2) included for now, although it isn't FF14-specific. The name `ff14` matches the roadmap and the feature plan; digits in folder names are ordinary. (`ffxiv`, the game's official abbreviation, is the alternative if the owner prefers it.)
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
  ff14/                    # created by E1: recruit, collections (B), Lodestone (C, the plan's src/news/), role check-in (E2, its member events in ff14/events/)
  minecraft/               # created by A: the plan's src/mcbridge/ becomes src/minecraft/bridge/
test/                      # mirrors src/
```

Empty folders aren't tracked by git, so `ff14/` and `minecraft/` are created by the first PR of their track, not here.

## Tasks

### 1. Snapshot the registered commands

- Branch `test/snapshot-command-definitions`; PR `test: snapshot every command's registered definition`.
- A test that loads each command and matches `data.toJSON()` against a Vitest snapshot (`toMatchSnapshot`, stored in `test/__snapshots__/`). A refactor that changes a name, option, description, choice or permission then fails it. Tasks 2 and 5 rely on it.
- Deploys: no runtime change.

### 2. Feature-folder layout and one command loader

- Branch `refactor/feature-folders`; PR `refactor: move src into core and reminders feature folders`.
- `git mv` everything to the target layout, except what tasks 3 to 6 create. Keep moves and edits apart (a commit of pure moves, then the import fixes) so the diff shows renames.
- `src/core/loadCommands.ts`: the command loop `index.ts` and `deploy-commands.ts` each copy today (the copies have drifted: one imports a path, the other a file URL), scanning `src/*/commands/*.ts`. `index.ts` loads events from `src/*/events/*.ts`.
- Tests move to mirror `src/`. Task 1's snapshot must pass unchanged.
- Update: CLAUDE.md's Architecture rules (commands live in `src/<area>/commands/`, `snooze.ts` and `reminderEmbed.ts` paths), README's file trees and paths, `ORACLE_CLOUD_DEPLOYMENT.md` (`src/events/ready.ts`), `vitest.config.ts`'s coverage `exclude`, and the feature plan's paths (`src/news/` → `src/ff14/lodestone/`, `src/mcbridge/` → `src/minecraft/bridge/`, `src/events/` for E2 → `src/ff14/events/`).
- Deploys: no user-visible change; the deploy re-registers the same command set (task 1's snapshot) and `src/index.ts` is where systemd expects it.

### 3. Storage split and decision record 0004

- Branch `refactor/feature-storage-modules`; PR `refactor: split storage into core/database.ts and reminders/storage.ts`.
- `src/core/database.ts` opens the database and exports the handle, and keeps every table's `CREATE TABLE`, `MIGRATIONS` (one sequence for all areas: `user_version` is a single number), `closeDatabase` and `__resetForTests`. `src/reminders/storage.ts` takes the reminder queries, their row interfaces and the limits. The SQL doesn't change; production's database needs nothing.
- While moving: `isGuildMasterEnabled(guildId)` replaces the `settings ? settings.master_enabled === 1 : true` copied in `/reminder list` and the status embed; `updateGuildReminder` returns the updated row, so `/reminder edit` doesn't read it again.
- Decision record 0004 (from `docs/decisions/0000-template.md`, indexed in its README): Context and Consequences drafted from the feature plan's "Feature storage modules" and this plan; **Why left as `TODO(Alex)`**. It names `core/database.ts` as the one module that opens SQLite and owns the schema, and each area's storage module as the only code in that area that queries it.
- Update CLAUDE.md's "`src/storage.ts` is the only module that touches SQLite" rule to match, and the feature plan: E1 no longer adds 0004, and its "next to `MAX_REMINDERS_PER_GUILD` in `storage.ts`" caps go in the area's own storage module. Decision 0002 is left as written (it records where migrations were when it was made).
- Deploys: no runtime change in behaviour; migrations and tables are untouched.

### 4. Shared Discord helpers in `core/discord.ts`

- Branch `refactor/shared-discord-helpers`; PR `refactor: share reply, time and message-length helpers`.
- `replyEphemeral(interaction, content)` for the ~23 `reply({ content, flags: MessageFlags.Ephemeral })` calls.
- `discordTime` moves from `snooze.ts`; `statusEmbed.ts` and `interactionCreate.ts`'s cooldown reply use it instead of building `<t:…:R>` by hand.
- One `DISCORD_MESSAGE_LIMIT` (two `MESSAGE_LIMIT = 2000` today) and one "add lines until the limit, then say how many were left out" function for `fitList` (`/reminder list`), `customEmoji.ts`'s `fit` and `reminderMessage.ts`'s `mentionsOutsideEmbed`. `fitTo` (cutting text on whole characters) moves here too.
- Discord error codes from discord.js's `RESTJSONErrorCodes` (exported by the installed 14.27.0, checked 2026-11-20) instead of `10003`/`10008` literals, and `isRefusedByDiscord` from `scheduler.ts`.
- The `CODE` regex moves out of `reminderMessage.ts`, which `customEmoji.ts` imports it from today.
- New tests for each helper; existing callers' tests unchanged.
- Deploys: no runtime change.

### 5. `/reminder`: one handler per subcommand

- Branch `refactor/reminder-subcommands`; PR `refactor: split /reminder into one handler per subcommand`. If it grows past a comfortable review, make it two PRs: the helpers, then the split.
- `execute` dispatches from a table of subcommand handlers in `src/reminders/subcommands/` instead of a 300-line `if` chain.
- A "find the reminder or reply 'No reminder found'" helper for the five subcommands that repeat it (with the lowercased `label`).
- Shared option builders: the `label` option with autocomplete (five copies), and `interval`, `message` and `embed`, which `/remindme` also uses. The after-snooze option's description moves to `snooze.ts` (copied in both commands today).
- `getChannel('channel', true, [ChannelType.GuildText])`, which narrows the type in discord.js 14.27.0 (checked 2026-11-20), replaces the four `as TextChannel` casts; `/reminder edit` reads the channel's permissions once for both warnings.
- One function for a reminder's `` • `label` — every Nm in <#channel> `` line, used by `/reminder list` and the status embed.
- Replacing the status message (delete the old one, post, save) moves from the `status` subcommand into `statusEmbed.ts`, which owns that message everywhere else.
- `/remindme` only switches to the shared helpers and option builders: roadmap item 6 rewrites it, so restructuring it now would be thrown away.
- Deploys: no user-visible change (task 1's snapshot, and the command tests unchanged).

### 6. Scheduler: a list of named checks

- Branch `refactor/scheduler-checks`; PR `refactor: run the scheduler's checks from a list`.
- `src/core/scheduler.ts` keeps the timer, the no-overlap guard per check, `runCheck`'s logging and `stopScheduler` waiting for running checks, over a list of `{ name, run }` instead of the hand-written `guildCheck` and `userCheck`. The reminder checks move to `src/reminders/dueReminders.ts`; `ready.ts` passes the list. E1 and E2 then add a check by adding to the list.
- The embed-or-plain-text choice, made separately for server and DM sends today, moves into one function beside `buildReminderMessage`.
- Not yet: a general poller for Lodestone (C2). Build it when C2 needs one, from this.
- Tests keep going through `startScheduler` with fake timers (CLAUDE.md).
- Deploys: no behaviour change; shutdown still waits for a send under way.

### 7. Interaction and event plumbing

- Branch `refactor/interaction-plumbing`; PR `refactor: tidy interaction routing and event loading`.
- `interactionCreate.ts`: look the command up once, one fallback error reply instead of two copies (`followUp` or `reply`), the cooldown as its own function. C4's button routing goes in after this.
- An `Event` type in `core/types/` for event modules (`index.ts` types them inline today).
- `import.meta.dirname` (Node 24.21, checked) instead of the `__filename`/`__dirname` lines in `index.ts`, `deploy-commands.ts` and `core/database.ts`.
- `customEmoji.ts` takes a narrow client interface (what it reads: `emojis.cache`) instead of all of `Client`, as #28 did for the scheduler and status embed.
- Deploys: no behaviour change.

### 8. Test helpers

- Branch `test/shared-test-helpers`; PR `test: share guild, channel and reply fakes`.
- `createMockGuild` for the three `makeGuild`s (different shapes today), the permissive and restricted channel fakes, and `replyContent`, in `test/mocks.ts` and `test/mockInteraction.ts`. Remove the unused `inGuild`, `member` and `getUser` from the interaction fake.
- Not changed: any test's expected values.
- For the owner: the roadmap's Later item "Type-check `test/` in CI" has a real reason now (this series renames every import, and Vitest strips types unchecked). It's new tooling, so it's the owner's call whether to do it here or as its own PR.
- Last task: adds the roadmap Done entry for the series and removes the refactor's Next up item.
- Deploys: no runtime change.
