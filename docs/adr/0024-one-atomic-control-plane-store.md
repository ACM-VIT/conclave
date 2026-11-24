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
- **JSON:** one SFU only. The process holds a lock file next to the store and renews it every 5 s; a second SFU refuses to start while the lock is younger than 30 s. Writes go to a temporary file renamed over the store.
- **Memory:** for tests, sharing one data object between two SFUs.

Unique keys (`(clientId, userId)`, `(clientId, username)`, `(profileId, slug)`, active `(clientId, roomCode)`, `linkSlug`, `(clientId, roomId)`, co-host token) are index records the entity registry derives from each record and the transaction claims and releases on every put and remove. A claim held by a record that no longer carries the key is treated as free.

Bookings read the booking page (profile, event type, hours, calendar, with revisions), compute slots and Google free/busy outside the store, then commit with those revisions and the calendar grant id as preconditions and an overlap check against the host's active meetings; a changed page retries once, a taken slot answers 409. The calendar settle, calendar failure, booking email result, reminder claim and reminder result are field-level commands on the current record. Every Google connect or reconnect gets a fresh grant id. Access tokens minted from a refresh token are cached in each SFU's memory by grant id and never written, so reads never write; only a revoked grant is recorded, and only while the grant it learned from is still held.

Each start imports the previous release's data: in Redis mode the old Redis meetings and scheduling hashes, else the old SQLite tables, else the old JSON files; webinars from the old SQLite table or JSON file. One normalizer per kind gives records deterministic stamps (hours take `updatedAt ?? profile.updatedAt ?? 0`, meetings and webinars `updatedAt ?? createdAt ?? 0`). An imported record is inserted only where neither a live record nor a deletion exists, and refreshed only while it was never written live and the old copy is newer. The old data stays where it is.

## Consequences

- Every answer is what was committed, a failed or rejected write changes nothing, deletes stay deleted, and no edit reverts another SFU's change to a different field.
- Reads cost a store round trip. Scans (lists, ticks, admin, overlap checks) read every record of a kind or tag; this is fine at today's volume and would need per-host indexes at a much larger one.
- Redis mode keeps no SQLite copy. Redis persistence (AOF and RDB) and the nightly backup are the only copies; losing Redis loses changes made since the upgrade, and the next start re-imports the frozen pre-upgrade data.
- During a blue-green deploy, writes an old SFU accepts after the first new SFU started reach the new store only if they created a record, and only when the next new SFU starts; edits and deletes made there are lost. A rollback finds the old data as it was at the upgrade.
- A GET may create the caller's own profile once, so the dashboard link works on first visit; it never changes an existing record.
- Host requests no longer copy the login name over the profile name, which reverted a host's own rename on their next request (found by the model).
- A booking moved after its Google event was created is recorded as a failed calendar sync with a reason; staging never updated such events either. Deleting or cancelling a booking later still leaves its Google event in the host's calendar, as on staging (found by the model; a follow-up).
- Lookups still fall back to legacy client ids, read-only; nothing moves namespace on a read. An attendee may join a webinar stored under a legacy alias of the deployment's default client.
- Legacy records that broke a unique key are kept without that key's index entry, newest first wins, and a warning names them.
- Revisit if a deployment needs more than a few thousand scheduled items per scan, or a second region.

## Alternatives considered

- **One Lua script per command (the design read's proposal):** rejected. Slot validity needs `Intl` time zones and the booking overlap rules, which would have to be rewritten in Lua and kept in step with TypeScript; one generic compare-and-commit script plus the shared reducer gives the same atomicity with one implementation of every rule, and the conformance suite runs the same commands on all four backends.
- **Per-record `rev + 1` and a per-host meetings revision:** rejected for a global commit counter. A global counter totally orders commits, so tests can replay the exact history, and the overlap check at commit replaces the per-host revision without spurious conflicts.
- **Legacy imports at revision 0 into an empty Redis only:** rejected. Every write must move a revision for the Redis checks to see it, so imports get a real revision plus a legacy stamp, and they run at every start so the second SFU of a deploy picks up records an old SFU created meanwhile.
- **Two transaction scopes (scheduling with meetings, webinars apart):** rejected. Every backend serializes per store anyway, so one scope costs nothing and removes a cross-scope case.
- **A PID lock for JSON:** rejected. Containers on one host reuse PIDs across PID namespaces, so a crashed holder's lock would look alive forever.
- **Keep the SQLite mirror in Redis mode:** rejected. A second writable copy is what diverged in #272.

## Verification

- `packages/sfu/test/control-plane-conformance.test.ts`: the same cases on memory, JSON, SQLite and Redis.
- `packages/sfu/test/control-plane-legacy-import.test.ts`: the previous release's SQLite, JSON and Redis formats load without loss, restarts rewrite nothing, deletes stay deleted.
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
- `packages/sfu/server/controlPlane/legacy.ts`: `readLegacyRecords`, `importLegacy`
- `packages/sfu/server/controlPlane/open.ts`: `resolveControlPlaneMode`, `openControlPlane`
