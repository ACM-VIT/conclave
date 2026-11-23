# SFU control-plane persistence: redesign

Status: proposed. This branch holds the multi-SFU persistence work that grew inside #272 (at 8fdfcf3b), plus a two-SFU model test and the failing cases below. #272 ships the platform hardening only, with staging's persistence behaviour. This document is the plan for a separate PR.

## Why the audit approach cannot close the bugs

Two active-active SFUs each keep a mutable in-memory copy of the control-plane records (profiles, hours, event types, calendar connections, scheduled meetings, scheduled webinars) on top of wall-clock last-write-wins storage. A change is planned, authorized and checked for uniqueness against local memory, stamped with the local clock, and written with a conditional upsert that silently keeps the higher stamp. The caller is never told whether its write won, so each route reconstructs the outcome with its own guard. Commit-time stamps, a branded committed type, mirror versions and the await audit fixed instances, but the same pattern repeats across three stores, three backends, startup, reload, import and the booking saga.

## Target design

1. The persistence authority is the single source of truth for reads and writes of control-plane data. No mutable memory copy for it. These are low-traffic paths and the handlers are already async.
2. The authority assigns a monotonic revision to each record (INCR in Redis, rev+1 in SQLite and JSON). `updatedAt` is for display only. Every write states its preconditions (expected revision for update and delete, must-not-exist for create, uniqueness keys, field predicates) and runs as one atomic transaction that either writes everything or nothing. It returns:

   ```ts
   type CommitResult<T> =
     | { ok: true; value: T; rev: number }
     | { ok: false; reason: "conflict" | "not_found" | "duplicate" | "forbidden" | "invalid"; message?: string };
   ```

   No plan or draft leaves the commit layer, so side effects cannot run when `ok` is false.
3. Entities that constrain each other share one transaction scope: scheduling and scheduled meetings sit under one store (one Redis hash tag, one SQLite `BEGIN IMMEDIATE`, one in-process queue for JSON and memory). A booking reads the host bundle (profile, hours, event type, calendar, active meetings and a per-host meetings revision), computes slots and Google free/busy outside any lock, then commits with a compare on each of those revisions, the calendar grant and an active room-code index. Any mismatch writes nothing and answers 409. Webinars get the same Redis adapter (they have none today) with an atomic link-slug index.
4. Sagas use field-level compare-and-set commands, and every Google connect or reconnect gets a fresh `grantId`: `patchCalendarToken(profileId, expectedGrantId, patch)`, `claimDueReminder(meetingId, now, leadMs)` atomic in every backend, `recordReminderResult` and `recordBookingEmailResult` touching only their fields, and `settleBookingCalendar(meetingId, expectedGrantId, eventId, syncedTimes)` checking grant, existence and times.
5. One legacy normalizer per entity at the storage boundary. A missing stamp never becomes the current time: hours take `updatedAt ?? profile.updatedAt ?? 0`, meetings and webinars `updatedAt ?? createdAt ?? 0`. Live writes have rev 1 or more. Legacy imports have rev 0 and may only insert where neither a live record nor a deletion exists.
6. One typed store interface with atomic commands and reads. Redis: one Lua script per command. SQLite only: one `BEGIN IMMEDIATE` per command, safe for two SFUs sharing one file. JSON: single instance only, with an exclusive lock file, the same pure TypeScript compare-and-commit reducer, and an atomic temp-file rename. Tests: the same reducer in memory.

Keep from #272: the SQLite write check, the startup lock retry, no silent SQLite-to-JSON fallback, deletion stamps for one-time legacy imports.

Drop: the live SQLite mirror in Redis mode (mirror writes, rebuilds, mirror versions, reseeding) in favour of Redis persistence plus a one-time startup migration; `POST /admin/reload-stores` and the merge and write-back reloads; the booking slot lease as a correctness lock; `persistThenApply` returning a plan, `committedRecords`, `assignInPlace` and `applyIfUnchanged`.

## Known violations at 8fdfcf3b

Paths are in `packages/sfu/server`.

Draft leakage and missing conflict checks:
1. `scheduling.ts`: `changeSchedulingHost` returns the draft and ignores deletions, so a losing edit or delete answers success.
2. `scheduledWebinars.ts`, `http/scheduledWebinarRoutes.ts`: deletions and losing upserts are unchecked, so a DELETE answers 200 and disables the live room.
3. `http/scheduledWebinarRoutes.ts`: the invite-code hash change and the co-host token come from the draft after a losing write.
4. `scheduledMeetings.ts`, `http/scheduledMeetingRoutes.ts`: the same as 2 for meetings.
5. `persistThenApply.ts`: returns the draft plan, and `committedRecords` only remaps objects with a top-level id.

Cross-store, multi-SFU and uniqueness races:
6. `http/schedulingRoutes.ts`: a booking checks availability outside the scheduling queue, against local memory only, and the commit-time recheck omits hours and internal busy times.
7. `scheduledMeetings.ts`, `http/schedulingRoutes.ts`: a 30 s lease and no overlap check in the save script let two SFUs double-book behind a slow free/busy call.
8. `scheduling.ts`, `http/schedulingRoutes.ts`: every host GET bumps `profile.updatedAt` and writes, overwriting a newer edit from the other SFU.
9. `scheduling.ts`: profiles get a random id with no `(clientId, userId)` uniqueness, so first requests on two SFUs create two profiles.
10. `scheduling.ts`, `scheduledMeetings.ts`: username, event-type slug and active room-code uniqueness are checked in local memory only.
11. `scheduledWebinars.ts`: no Redis mode for webinars, and a SQLite link-slug UNIQUE error surfaces as 503.
12. `scheduledMeetings.ts`, `scheduling.ts`: whole-record wall-clock last-write-wins reverts unrelated field edits and depends on clock skew.
13. `http/scheduledMeetingRoutes.ts`, `http/scheduledWebinarRoutes.ts`: GET routes run namespace migrations that bump `updatedAt` and swallow errors.
14. `http/schedulingRoutes.ts`: a calendar reconnect validates the refresh token against stale memory and can bring back a deleted token.
15. `http/scheduledWebinarRoutes.ts`: co-host access is rechecked only against local memory.

Sagas, ticks and reminders:
16. `http/schedulingRoutes.ts`: the grant check is local; settle and booking follow-ups write whole stale meeting copies over a reschedule or cancel; a booking can answer 201 after it was deleted.
17. `scheduledMeetings.ts`: the Redis reminder claim script has no seeded-marker guard.
18. `schedulingEmailReminders.ts`: the SQLite and JSON reminder claims are not conditional, result writes are whole stale records, and module-level state is shared across SFU states.
19. `scheduledWebinarScheduler.ts`, `socket/handlers/joinRoom.ts`: the tick changes live room configs before the queue, and the join count is a fire-and-forget whole-record write.

Legacy stamps, mirror, reload and backends:
20. `scheduling.ts`: legacy hours loaded at startup take the current time.
21. `scheduledMeetings.ts`, `scheduledWebinars.ts`: the same for meetings and webinars.
22. `scheduling.ts`: the upsert and the older-row delete compare different stamps.
23. `scheduling.ts`: the Redis seed omits the client id, the JSON commit reads it from the hours record, and mirror rows are rewritten to the default client.
24. `scheduling.ts`, `stampedJsonFile.ts`: the JSON read-modify-write is unlocked, a save overwrites deletion stamps, the pre-import profile cache never expires, and the image puts JSON on the shared recordings volume.
25. `scheduledMeetings.ts`, `scheduledWebinars.ts`, `scheduling.ts`: startup loads are not strict in SQLite and JSON modes.
26. `scheduledMeetings.ts`, `redisCommitVersion.ts`: the mirror is rebuilt outside the write queue, the mirror version uses Redis TIME after a flush, and both SFUs share one mirror file.

## Failing cases on this branch

- `test/route-persistence-failure.test.ts`, `two SFUs on one store`: an event-type edit that loses to the other SFU answers with the losing value; webinar and meeting deletes that lose to a newer edit answer 200 (and the webinar's room link is cleared).
- `test/route-persistence-failure.test.ts`, `a booking waiting to save`: a booking queued behind a meeting save commits into hours the host closed meanwhile.
- `test/store-commit-invariant.test.ts`, `legacy hours loaded at startup`: in sqlite, json and redis modes, a reload writes the startup-stamped legacy hours over newer recovered hours.
- `test/store-model.test.ts`: two SFUs over one store in each mode, with a seeded scheduler that parks every store write and releases them in random order. Over 24 seeds of 60 steps per mode at 8fdfcf3b it found, in all three modes: bookings committed into hours storage had closed (8 seeds), event-type edits answered with a value storage did not keep (3), memory hours differing from storage after a restart (2), reloads rewriting the stored hours (2 in sqlite and redis), and a meeting deleted with a 200 coming back after a stale SFU edited it (1).

## Test strategy for the redesign

1. The model-based two-SFU harness, extended with skewed clocks, a fake Google Calendar and email worker with pause points, calendar connect and disconnect, ticks, reminder scans, co-host invites, join counts, legacy file injection and transient storage errors. After every step it checks against a linearizable reference: every 2xx equals committed authority state; rejected writes cause no side effects; every committed booking is inside committed hours, on an active event type and non-overlapping; GETs never write; uniqueness of `(clientId, userId)`, `(clientId, username)`, `(profileId, slug)`, active `(clientId, roomCode)` and link slug; no lost update or resurrection; reminders at most once that never revert a live or cancelled meeting.
2. A backend conformance suite over memory, json, sqlite and redis: compare-and-set mismatch on update and delete, duplicate rejection, atomic booking precondition failure, atomic reminder claim, field patch isolation, legacy normalization, strict startup failure.
3. The write-step failure and restart matrix, extended to all three domains.

Sizing: about 3 to 5 focused days (store interface and reducer, SQLite and Redis adapters, removal of the current glue, tests).
