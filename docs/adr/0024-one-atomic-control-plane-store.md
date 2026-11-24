# 0024. One atomic control-plane store for scheduling, meetings and webinars

- Status: Accepted
- Date: 2026-11-24

## Context

Production runs two SFUs on one host, behind one public URL, with a shared Redis and a shared SQLite file on the recordings volume. Scheduling profiles, hours, event types, Google Calendar connections, scheduled meetings and scheduled webinars were each kept in a mutable memory copy per SFU, loaded once at startup, and saved as whole records or whole snapshots with wall-clock last-write-wins. An SFU planned, authorized and checked uniqueness against its own stale copy, and the save silently kept whichever stamp was higher, so callers never learned whether their write won. A design read of #272 (Neon, 2026-11-23) listed 26 places where this loses, resurrects or misreports writes, and a two-SFU model test on that branch found five more problem types. Patching each instance had already failed: the same pattern repeated across three stores, three backends, startup, reload, import and the booking saga.

## Decision

All six kinds live in one store with one transaction scope. A route runs a command: a pure, synchronous reducer over a transaction view that reads records, unique keys and tags and stages puts and removes. The store commits the staged writes atomically, gives them the next value of one global revision counter, and returns `CommitResult<T>`: `{ ok: true, value, rev }`, or `{ ok: false, reason }` with `conflict`, `not_found`, `duplicate`, `forbidden` or `invalid` and nothing written. Routes cause side effects (room configs, Google events, emails) only on `ok`, read only from the store, and answer 503 when storage fails.

The same reducer runs on every backend:

- **Redis:** optimistic transactions. The reducer runs against a snapshot fetched on demand; a key it needs but has not fetched aborts the run, the key is fetched, and the reducer runs again from the start with the same clock and replayed randomness. One commit script checks the revision of every record read, the owner of every unique key read, the version of every tag or kind scanned and every tombstone read, then applies the writes or reports a conflict, and the command retries.
- **SQLite:** one `BEGIN IMMEDIATE` per command, with the reducer running inside it, so two SFUs may share one file.
- **JSON:** one SFU only. The process holds a lock file next to the store and renews it every 5 s; a second SFU refuses to start while the lock is younger than 30 s. Every commit and every rename first checks that this SFU still holds the lock, so a writer that stalled past 30 s and lost it stops instead of overwriting newer saves. Writes go through #272's private writer: a 0600 temporary file, fsynced, renamed over the store, then the directory fsynced; the lock file is 0600 too.
- **Memory:** for tests, sharing one data object between two SFUs.

Unique keys (`(clientId, userId)`, `(clientId, username)`, `(profileId, slug)`, active `(clientId, roomCode)`, `linkSlug`, `(clientId, roomId)`, co-host token) are index records the entity registry derives from each record and the transaction claims and releases on every put and remove. A claim held by a record that no longer carries the key is treated as free.

Bookings read the booking page (profile, event type, hours, calendar, with revisions), compute slots and Google free/busy outside the store, then commit with those revisions and the calendar grant id as preconditions and an overlap check against the host's active meetings; a changed page retries once, a taken slot answers 409. The calendar settle, calendar failure, booking email result, reminder claim and reminder result are field-level commands on the current record. Every Google connect or reconnect gets a fresh grant id. Access tokens minted from a refresh token are cached in each SFU's memory by grant id and never written, so reads never write; only a revoked grant is recorded, and only while the grant it learned from is still held.

Each start imports the previous release's data, so an old SFU that keeps serving during a blue-green deploy loses nothing. One normalizer per kind, reading every stored number through #272's `storedTimestampOrNull`, gives records deterministic stamps (hours take `updatedAt ?? profile.updatedAt ?? 0`, meetings and webinars `updatedAt ?? createdAt ?? 0`). Per domain (scheduling, meetings, webinars) the first import picks the first old store holding records: in Redis mode the old Redis hashes, else the old SQLite tables, else the old JSON files; webinars from SQLite, else JSON. That choice is saved and later starts read only that store, so emptying it never falls back to a stale copy.

Every old source is a history the import replays in order with one three-way rule. The old store is one source. The deploy also saves the JSON files old images kept in their container layer when SQLite was locked into `CONCLAVE_FALLBACK_IMPORT_DIR/<service>/<stamp>-<deploy id>/`, one folder per transfer that is never replaced (#272): the folders of one service and one deploy id are successive snapshots of one old container, ordered by stamp, and each container is its own source; a copy an older deploy left directly in `<service>/` is a source of one snapshot. For every record and every source the import keeps a shadow, the hash and stamp of that source's copy it last saw, and compares the source now, that shadow and the live record:

- The source's copy is unchanged since its shadow: nothing happens.
- The source changed the record, or dropped it from a later snapshot, and the live record is still exactly the source's last copy: the change is applied, whatever its stamp, and a dropped record is deleted with a tombstone.
- The live record was changed here since: it is kept and a warning names the record.
- The live record came from another old source: the newer stamp wins, and equal stamps with different contents keep the live record and are named.
- A source shows a record for the first time: it is added where nothing holds it, and otherwise the newer stamp wins as above.

Every delete also writes a removal record listing the identity and hash of every version of that key it deleted, the last 64 (a calendar's identity is its connection id, since calendars are keyed by profile; every other kind uses its id). A deletion, here or applied from an old source, blocks only those exact records from coming back: a new calendar connection the old SFU makes for the same host is taken, and an old-side edit of any deleted connection is a conflict. 64 bounds the record while covering far more disconnects of one host than can happen between a snapshot and its import, since old sources are frozen at the upgrade.

Each start takes a ticket in the store first and every import batch checks it, so an import that started earlier and runs slow stops instead of writing an older view over a newer one. An import ends by recording its ticket as completed. A store is ready only after the import that covers it has completed: an SFU whose import was superseded waits until a newer import completes, polling the store, and fails startup if none does within `CONTROL_PLANE_LEGACY_IMPORT_WAIT_MS` (120 s by default), so it never serves a first visit before the old profile it would otherwise duplicate is in place. Each start claims every container copy before reading it by renaming it to `<name>.claimed-<ticket>-<n>`; a newer import takes over the claims of an older one, and an import that loses a claim to a newer one skips that file, since its owner imports it, instead of failing. Only after the import completes is each claimed file, if its bytes still hash to what was imported, renamed with an `.adopted` suffix; a copy the deploy writes meanwhile stays under its own name for the next start, and a superseded import that still holds claims runs again once the newer one completes. A calendar token in any old store or copy that this SFU's secret cannot decrypt stops startup instead of dropping it. The old data stays where it is.

## Consequences

- Every answer is what was committed, a failed or rejected write changes nothing, deletes stay deleted, and no edit reverts another SFU's change to a different field.
- Reads cost a store round trip. Scans (lists, ticks, admin, overlap checks) read every record of a kind or tag; this is fine at today's volume and would need per-host indexes at a much larger one.
- Redis mode keeps no SQLite copy. Redis persistence (AOF and RDB) and the nightly backup are the only copies; losing Redis loses changes made since the upgrade, and the next start re-imports the frozen pre-upgrade data.
- During a blue-green deploy, creates, edits and deletes an old SFU accepts after the first new SFU started reach the new store when the next new SFU starts; where the same record was also changed here, this store's version wins and the log names the record for a manual check. A rollback finds the old data as it was at the upgrade plus whatever the old SFU wrote.
- #272's JSON merger (`jsonStoreUpgrade.ts`) is gone; the import above is the one path for its recovered copies, in every mode, not only JSON. Unlike that merger, copies are snapshots of one container replayed in order rather than a bag of records, so a record a container deleted between its snapshots stays deleted; a copy that clashes with a unique key is kept without the key (as other legacy clashes are); two sources that changed one record differently at the same stamp keep the first one imported and log the record instead of stopping startup; and it writes no `.premerge` backup because it never rewrites the old files.
- A SQLite commit waits at most 1 s for another SFU's write lock (node:sqlite waits inside the event loop) and then answers 503; two SFUs committing back to back on one file waited at most 383 ms under twice-the-cores CPU load, p99 0.03 ms. Startup keeps 5 s and its retry loop.
- Startup can wait for another SFU's import (up to `CONTROL_PLANE_LEGACY_IMPORT_WAIT_MS`); a refused copy is renamed back from its claimed name so it stays where the deploy put it.
- An undecryptable calendar token in the old data stops startup with the record named, as #272 did for copies; the fix is setting `SCHEDULING_TOKEN_SECRET` to the old secret, or removing that connection from the old store.
- A GET may create the caller's own profile once, so the dashboard link works on first visit; it never changes an existing record.
- Host requests no longer copy the login name over the profile name, which reverted a host's own rename on their next request (found by the model).
- A booking moved after its Google event was created is recorded as a failed calendar sync with a reason; staging never updated such events either. Deleting or cancelling a booking later still leaves its Google event in the host's calendar, as on staging (found by the model; a follow-up).
- Lookups still fall back to legacy client ids, read-only; nothing moves namespace on a read. An attendee may join a webinar stored under a legacy alias of the deployment's default client.
- Legacy records that broke a unique key are kept without that key's index entry and a warning names them; within one old store the newest holds the key, and against a container copy the record already in the store keeps it.
- A webinar's invite code hash is stored on its record, never returned by the API, and applied to the room like the other schedule controls, so the SFU hosting the room enforces a code set through any SFU. Every webinar tick re-applies the stored webinar to each scheduled room the SFU hosts when its revision changed, and releases the room when the webinar is gone, so an end, cancel, delete or edit made through another SFU reaches the room within one tick.
- A JSON writer frozen for more than 30 s between its lock check and the rename that follows could still overwrite one save; JSON is for a single SFU, and this is the window left.
- Revisit if a deployment needs more than a few thousand scheduled items per scan, or a second region.

## Alternatives considered

- **One Lua script per command (the design read's proposal):** rejected. Slot validity needs `Intl` time zones and the booking overlap rules, which would have to be rewritten in Lua and kept in step with TypeScript; one generic compare-and-commit script plus the shared reducer gives the same atomicity with one implementation of every rule, and the conformance suite runs the same commands on all four backends.
- **Per-record `rev + 1` and a per-host meetings revision:** rejected for a global commit counter. A global counter totally orders commits, so tests can replay the exact history, and the overlap check at commit replaces the per-host revision without spurious conflicts.
- **Legacy imports at revision 0 into an empty Redis only:** rejected. Every write must move a revision for the Redis checks to see it, so imports get a real revision plus a legacy stamp, and they run at every start so the second SFU of a deploy picks up what an old SFU changed meanwhile.
- **Two-way legacy refresh by stamp:** rejected. An old SFU's edit can carry an older stamp than the import (another clock), and a delete carries none, so only a saved copy of what was imported tells an old-side change from a live one.
- **Two transaction scopes (scheduling with meetings, webinars apart):** rejected. Every backend serializes per store anyway, so one scope costs nothing and removes a cross-scope case.
- **A PID lock for JSON:** rejected. Containers on one host reuse PIDs across PID namespaces, so a crashed holder's lock would look alive forever.
- **Keep the SQLite mirror in Redis mode:** rejected. A second writable copy is what diverged in #272.

## Verification

- `packages/sfu/test/control-plane-conformance.test.ts`: the same cases on memory, JSON, SQLite and Redis.
- `packages/sfu/test/control-plane-legacy-import.test.ts`: the previous release's SQLite, JSON and Redis formats load without loss, restarts rewrite nothing, deletes stay deleted.
- `packages/sfu/test/control-plane-legacy-alongside.test.ts`: an old SFU editing, deleting and creating in its SQLite, JSON or Redis store while new SFUs restart, as fixed cases and as a seeded model checked against the three-way rules, plus two imports racing.
- `packages/sfu/test/control-plane-import-model.test.ts` (red on 8d25944): Greptile's three cases (a container's before-stop and after-stop copies, a host who disconnects twice, a claim taken over before it is read) and a seeded model of the import protocol: several SFUs restarting alone or importing at once, one paused after its claim or its read while another takes over, an old store that creates, edits, deletes and reconnects, and old containers that keep writing between their snapshots. After every import the store equals the three-way merge of each source's history, startup never fails, and only unclaimed copies remain.
- `packages/sfu/test/control-plane-claim-race.test.ts` (red on 8d25944): a newer import renaming a claimed copy between this import's claim and its read, at the file system, does not stop startup.
- `packages/sfu/test/control-plane-sqlite-lock-wait.test.ts`: a SQLite commit blocked by another SFU's write lock fails as a storage error after `SQLITE_COMMIT_WAIT_MS` (1 s) instead of the 5 s startup timeout.
- `packages/sfu/test/control-plane-import-protocol.test.ts` (red on d023ae1a): an old SFU's calendar disconnect then reconnect, a reconnect there after a disconnect here, a superseded SFU that serves nothing until the newer import completes or fails loudly, and a container copy replaced while an import runs.
- `packages/sfu/test/control-plane-recovered-copies.test.ts`: #272's container copies adopted once in every mode, newer edits kept, same-stamp copy differences and undecryptable tokens refused.
- `packages/sfu/test/control-plane-legacy-roundtrip.test.ts`: #272's round-trip test ported: every field of current records and of #272's older-SFU fixture files, as missing, null, 0, empty, set, text, true or a number, reads back from the store with the hash it was imported with, so the three-way comparison never sees a change that was not made.
- `packages/sfu/test/control-plane-json-file-mode.test.ts`: the JSON store and its lock stay 0600 under umask 022.
- `packages/sfu/test/control-plane-staging-rollback.test.ts`: #272's rollback test ported: files staging's own code wrote during a rollback, saved in the deploy's archive folders, import with every untouched record kept and staging's edit applied.
- `packages/sfu/test/control-plane-unique-rivals.test.ts`: a clashing pair for every unique index a stored kind declares, from one old store and from a container copy.
- `packages/sfu/test/control-plane-first-visit.test.ts`: two SFU processes on one SQLite file or one Redis answer concurrent first dashboard visits with one profile per host.
- `packages/sfu/test/control-plane-failure-matrix.test.ts`: a real storage failure on every write of all three domains answers 503, changes nothing, and survives a restart.
- `packages/sfu/test/control-plane-model.test.ts`: two SFUs with skewed clocks, pause points at every commit, free/busy, Google event creation and email send, checked against the commit history after every step.
- `packages/sfu/test/control-plane-cases.test.ts`: one black-box case per problem, tagged with the design read's numbers; run against staging and 8fdfcf3b with a harness that boots each tree's own stores.

| Design read item | Case tag | Red on |
| --- | --- | --- |
| 1, 22 losing or deleted scheduling edits answered 200 | [1, 12, 22], [1, 22] | staging, 8fdfcf3b |
| 2, 4 webinar and meeting deletes, stale edits after a delete | [2], [4, 22] | staging, 8fdfcf3b |
| 2, 4, 5 a delete from a slow-clock SFU that loses but answers 200 | [2, 5], [4, 5] | 8fdfcf3b |
| 3 invite code and co-host token from a losing draft | [3, 15], [3] | staging, 8fdfcf3b |
| 5, 16 saga answers and writes over a delete or a move | [5, 16], [16] | staging, 8fdfcf3b |
| 6 booking checks outside the commit | [6] | staging, 8fdfcf3b |
| 7 lease and slow free/busy double booking | [7] | staging, 8fdfcf3b |
| 8 reads that write | [8] | staging (SQLite) |
| 9 duplicate first profiles | [9] | staging |
| 10 room code and event slug only checked in memory | [10] (two cases) | staging, 8fdfcf3b |
| 11 link slug clash answered as saved | [11] | staging, 8fdfcf3b |
| 12 whole-record last-write-wins | [12], [1, 12, 22] | staging, 8fdfcf3b |
| 13 namespace moves on reads | [13] | staging, 8fdfcf3b |
| 14 reconnect revives a removed token | [14] | staging, 8fdfcf3b |
| 15 co-host access from memory | [15], [3, 15] | staging, 8fdfcf3b |
| 18 reminder claims that are not atomic | [17, 18] | staging, 8fdfcf3b (SQLite) |
| 17 the Redis claim skipping the reseed guard | [17, 18] | neither: the guard only mattered while a mirror reseeded a flushed Redis, which no longer exists; the case pins that claims are atomic in every backend |
| 18 reminder results written as whole stale records | [18] | staging, 8fdfcf3b |
| 19 ticks that undo edits | [19] | staging, 8fdfcf3b |
| 20 legacy hours stamped with the clock, reloads rewriting hours | [20] | staging, 8fdfcf3b |
| 21 legacy meeting and webinar stamps from the clock | [21] | staging, 8fdfcf3b |
| 23 client id in mirror columns | [23] | neither: the wrong value lands only in an index column nothing reads, so the case pins the visible contract |
| 24 unlocked JSON on a shared file | [24] | staging |
| 25 non-strict startup loads | [25] (SQLite and JSON) | staging, 8fdfcf3b |
| 26 a second copy beside Redis | [26] | staging, 8fdfcf3b (Redis) |
| model: bookings into closed hours | [6] | staging, 8fdfcf3b |
| model: answers storage did not keep | [1, 12, 22] | staging, 8fdfcf3b |
| model: hours differ from storage after a restart | hours finding | staging, 8fdfcf3b |
| model: reloads rewrite stored hours | [20] | staging, 8fdfcf3b |
| model: a deleted meeting comes back after a stale edit | [4, 22] | staging, 8fdfcf3b |

## Code

- `packages/sfu/server/controlPlane/tx.ts`: `execute`, `query`, `TxImpl`, `ReplayEntropy`
- `packages/sfu/server/controlPlane/entities.ts`: `entities`
- `packages/sfu/server/controlPlane/backends/redis.ts`: `createRedisBackend`, `COMMIT_SCRIPT`
- `packages/sfu/server/controlPlane/backends/sqlite.ts`, `json.ts`, `memory.ts`
- `packages/sfu/server/controlPlane/schedulingCommands.ts`: `bookSlot`, `settleBookingCalendar`, `claimDueReminder`, `patchCalendarToken`
- `packages/sfu/server/controlPlane/legacy.ts`: `readLegacyDomains`, `readRecoveredCopies`
- `packages/sfu/server/controlPlane/legacyImport.ts`: `runLegacyImport`, `reconcileLegacy`, `adoptRecovered`
- `packages/sfu/server/controlPlane/open.ts`: `resolveControlPlaneMode`, `openControlPlane`
