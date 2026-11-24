# Telemetry

Conclave sends errors and call-quality numbers to PostHog. Nothing here carries
names, emails, chat text or room codes.

## Turning it on

| Where | Variable | Effect |
| --- | --- | --- |
| Web build | `NEXT_PUBLIC_POSTHOG_KEY` | Project key. Without it the browser loads nothing, reads no call stats and sends nothing. |
| Web server | `POSTHOG_INGEST_HOST` | Where `/ingest` forwards the browser's events, such as `https://eu.i.posthog.com`. The browser never talks to PostHog itself. |
| Web server | `NEXT_PUBLIC_POSTHOG_HOST` | Read only when `POSTHOG_INGEST_HOST` is unset, so a deployment that set it before `/ingest` existed keeps its collector. With neither set, or neither an http(s) URL, `/ingest` forwards nothing: it answers 503 and logs once. There is no built-in collector. |
| Web dev | `NEXT_PUBLIC_POSTHOG_DEV=1` | `next dev` only sends events with this set. |
| Web deploy | `CI=true`, `POSTHOG_SOURCEMAPS_UPLOAD=1`, `POSTHOG_CLI_API_KEY`, `POSTHOG_CLI_PROJECT_ID`, `POSTHOG_CLI_HOST` | `cf:build` builds, uploads and deletes browser source maps (needs `posthog-cli` on PATH), only when `CI=true` and `POSTHOG_SOURCEMAPS_UPLOAD=1` are both set along with the credentials: credentials left in a developer's `.env.local` never upload anything. One rule (`scripts/posthog-sourcemaps-policy.mjs`) decides both whether `next build` makes maps and whether the upload runs. Other builds, `cf:preview` included, make no maps. A failed upload, or one still running after 90 s (`POSTHOG_SOURCEMAPS_TIMEOUT_MS`), warns and the deploy goes on without readable stacks. The CLI runs in its own process group, so a stalled upload is stopped with its native uploader child before the maps are removed, which they always are. Ctrl-C or SIGTERM is passed on to that group, the maps are removed, and the script exits 130 or 143. Exited (zombie) processes count as gone, for containers with no init to reap them. |
| SFU | `SFU_POSTHOG_KEY`, `SFU_POSTHOG_HOST` | Server exceptions and game events. `SFU_POSTHOG_ENABLED=0` turns both off. Always off under vitest. |

## Exceptions (`$exception`)

Web, from `lib/telemetry.ts`. It starts when the first page mounts or the
first report arrives, and from the moment the module loads every report
(`telemetry.capture`, `captureException`, and `logCallError`, whose capture is
installed then) goes into one queue of up to 50. The queue waits while the SDK
downloads and, once it has loaded, until the build's chunk manifest has too,
or 5 s have passed, so a first-render error keeps its chunk paths. Then each
report goes to the SDK, which only builds the event: `before_send` puts it in
the outbox (`lib/telemetry-outbox.ts`). An error posthog-js captures itself
during that wait is held, as it was captured, until the manifest request is
answered (then built against the manifest, if there is one) or the 5 s have
passed (then built without it, so chunk frames are `[path]`). Either way
posthog-js never sends a request
of its own, so it holds no queue that a tab hidden and then frozen or dropped
would lose.

The outbox sends events to `/ingest` in batches, so a call costs a handful
of requests rather than one per event. A batch goes 5 s after its first event,
as soon as it holds 20 events, or before it would pass 48 KB (under the
browser's 64 KB budget for keepalive requests and beacons), whichever comes
first. An exception sends early, at most once every 3 s. An event is queued
once by its uuid, and cut down at once to at most 32 KB (an exception's
extra causes and outer frames first, then any text over 1 KB, then its
largest fields), so no one report can push a batch past its limit. Every
telemetry request, the chunk manifest's included, goes through one helper,
`lib/telemetry-fetch.ts`, which sets `credentials: "omit"`, `referrerPolicy:
"no-referrer"` and `cache: "no-store"` and gives the request its own
deadline (`AbortSignal.timeout`: 15 s for a send, 5 s for the manifest), so
no request carries the auth cookie or the page's URL; a test fails if any
browser telemetry module calls `fetch` or `sendBeacon` itself. `sendBeacon`,
which always sends cookies and the referrer, is not used, and the send as a
page goes away is a keepalive `fetch` through the same helper instead (where
a browser has no keepalive `fetch`, the batch is saved for the next load). Every event
is built through the outbound schema again each time it is sent, so a saved
copy from storage is checked like a new one, against the build it was made
in: it keeps its own `client_version`, and its frames are checked against
that build's chunk list when this page has it (the same build, once its list
has loaded). Otherwise a frame keeps its chunk id and chunk file as long as
each has the right form, and `/ingest` checks them against that build's own
list. The rebuilt copy is only sent; the saved batch keeps the original. Each
send carries its own `sent_at`, so `/ingest` can tell the events' age by the
browser's clock.
One table, in `lib/telemetry-answers.ts`, says what an answer means, for the
outbox reading `/ingest` and for `/ingest` reading PostHog: 2xx is delivered;
408, 425, 429 and any 5xx are worth sending again; anything else is refused
for good.

The outbox owns every batch until `/ingest` answers it, and each batch has
one owner at a time:

- **In memory.** A batch only this tab holds is sent by this tab and retried
  by this tab's timer: after 2, 4, 8 and 16 s, then every 30 s, or after the
  answer's `Retry-After` when that is later (seconds or an HTTP date, held to
  60 s). A `Retry-After` only ever moves the next try later, and no path sends
  a batch before `max(nextTry, notBefore)`: a timer that fires early is set
  again for the batch's due time. That holds for the send as a page goes
  away too: a batch in backoff, or beaconed less than 30 s ago, is saved, not
  sent again, however many lifecycle events follow. Every request has a 15 s
  deadline (`/ingest` itself allows 2 s for a manifest and 10 s for
  PostHog); at the deadline it is aborted and counts as no answer. The
  request carries that deadline itself, from the fetch helper, so it ends
  even when the tab's timer does not run. A tab the browser freezes runs
  neither until it thaws, so its request can outlast the lease and meet
  another tab's replay; `/ingest` does not forward again an event PostHog
  already took (Retries, below).
- **Saved.** On `visibilitychange` to hidden, on `pagehide` and on `freeze`,
  everything queued and every batch waiting in memory that is due goes by
  beacon (a keepalive `fetch`), within one 56 KB budget for every keepalive
  request still outstanding; then each is saved in local storage
  under its own key, `conclave:telemetry:batch:<uuid>`, at most 512 KB in
  all. A request in flight is saved too, with its attempt id and a lease. A
  saved batch keeps its place in the retry schedule (`attempt`, `nextTry`,
  `notBefore`), and a beaconed one is sent again 30 s later to confirm it,
  since the page may not live to read its answer; when storage refuses a
  beaconed batch, its retry timer moves to that time too. When the page does
  read an answer worth retrying, its `Retry-After` moves the saved batch's due
  time (`notBefore`) and the events it names as refused are dropped, while
  the stored copy is still that beacon's; if storage refuses that write, the
  tab takes the batch back into memory with the new due time and removes the
  stale stored copy.
- **Replayed.** A saved batch is sent only by a replay pass, which runs under
  a Web Locks lock (`conclave:telemetry:replay`) at its due time, when a tab
  loads or comes back into view, and when another tab changes a saved batch
  (the `storage` event). The pass claims a due batch by writing a new attempt
  id and a lease until 16 s after the send, so another tab leaves it alone
  until the request has settled; an answer from an earlier attempt changes
  nothing. Without the Web Locks API two tabs may both claim a batch, and
  `/ingest` takes each uuid once. Reading a saved batch back checks each of
  its events on its own (a uuid, an ISO timestamp, an event name and a
  properties object): a malformed event is dropped and the rest are kept,
  and a batch with none left is removed.
- **Refused by storage.** When local storage refuses a write, blocked or
  full, the batch stays in memory and its tab keeps retrying it. A tab that
  closes while storage refuses it and its beacon fails loses that batch; that
  is the one loss nothing can count.

Saved and retried batches expire. `/ingest` keeps an event's own time only
within 5 minutes of receiving it, so a batch whose oldest event is more than 4
minutes old is dropped, never sent to be dated by when it arrived. The
batches one replay drops are reported together as
`telemetry_reports_dropped`: `batches`, `events` (the reports in them), and
`unsent`, the batches that had no send which may have arrived (a beacon or a
keepalive request in flight as the page went away). The full lifecycle, every
state and event with the owner of the next step, is in the PR that added it
(#265), and `test/telemetry-outbox-model.test.ts` checks it in a seeded
simulation of up to three tabs.

Once the page has started to go away (hidden, `pagehide` or `freeze` seen),
every later report, such as the call summary the call tracker sends as the
page closes, goes out at once the same way, whatever state the SDK is in; so
does a report marked immediate. Held reports are built first:
through the SDK if it has loaded, against the manifest if it has loaded; while
it is still awaited, a chunk frame keeps its chunk id and file as long as each
has the right form, so the beacon and the saved copy keep them for `/ingest`
to check against that build's manifest. Before the SDK has loaded, as events
we build ourselves
from the outbound schema. Those carry the fields we can vouch
for without the SDK: the project token, the stored SDK id (or a new uuid), the
build, our host and the report's own fields; an exception keeps its type and,
for a call-log label, its message, but no frames. If the SDK fails to load,
reports go the same way. Only an answer to the manifest request ends the wait early: a page that
navigates away aborts that request before the `pagehide` listener runs, and
the abort must not release the reports as if the page stayed. PostHog's own
error capture starts as soon as it loads, and what it captures waits with
our own reports. Each report is built when it is sent, and again at every
later send:

- Unhandled errors and promise rejections (posthog-js autocapture, rate limited per error type by the SDK).
- Errors caught by `app/error.tsx` and `app/global-error.tsx`: `source: "react_error_boundary"`, `boundary: "route" | "root"`, `digest`. A meeting panel that fails to render or load (`MeetingPanelBoundary`) reports `boundary: "panel"` while the call goes on; the panel's name is not sent.
- Call failures logged with `logCallError(label, ...details)` (`lib/call-error-capture.ts`): `source: "call_log"`, `call_log` (the label). The exception's message is the label. `label` is a `CallLogLabel`, the type of `CALL_LOG_LABELS` in `lib/call-log-labels.ts`, so an unregistered label does not compile, and a lint rule rejects `console.error("[Meets] ...")`, which would bypass it. A logged Error keeps its type and stack frames, never its message. Other logged values are dropped. At most 3 per label and 30 in total per minute.
- Errors built from server text (socket ack `error` fields and the like) are thrown as `ServerError`, so the type says where the text came from. Like every message that is not a call-log label, theirs is withheld. A lint rule flags `new Error(x.error)`.

SFU, from `server/analytics/errorReporter.ts`, every event tagged `sfu_instance_id`, `sfu_region`, `sfu_version`. The configured instance and region are operator text, so `sfu_instance_id` is `sfu_` and a keyed hash of the instance name (also the event's distinct id), keyed with `SFU_SECRET` or, without a real one, a key that lives only in that process; and `sfu_region` comes from a fixed list of cloud regions plus `local`, else `other`. `sfu_version` is the version the SFU's own `package.json` declares, never `SFU_VERSION` or any other configured text:

| `source` | When | Extra properties |
| --- | --- | --- |
| `uncaught_exception`, `unhandled_rejection` | The process is about to exit (level `fatal`, waits at most 2s to send) | |
| `startup_failed` | `server.start()` rejected | |
| `socket_handler` | A socket.io handler threw or rejected | `socket_event`, only when the server registered a handler for that event |
| `worker_died` | A mediasoup worker died | `worker_label`, `worker_pid` |
| `worker_respawn_failed` | Its replacement failed to start. The slot keeps retrying, and attempts 1, 2, 4, 8 and so on are reported | `worker_label`, `respawn_attempt` |
| `redis_transient` | A Redis error the crash guard swallowed (level `warning`) | `process_event` |

At most 5 reports per distinct error and 60 in total per minute per instance.
The fatal report before an exit is outside that limit.

The crash guards and the reporter start before the SFU's configuration loads:
they read their settings straight from the environment
(`server/analytics/settings.ts`, after the `.env` files in `config/env.ts`),
and `server.ts` imports everything that reads the configuration only once the
guards are in place. A configuration that fails as it loads, such as one with
both WebRTC transports turned off, is reported as `startup_failed` before the
process exits.

## Call-quality events

Each tab sends at most one `call_join` per join attempt, one `call_first_media`
and one `call_summary` per call, whatever the room size. `call_id` is a random
id per attempt that ties the three together. Times are milliseconds; "from the
click" means from the moment the join started (`connecting`). Stats are sampled
from the receive transport and the camera producer every 250 ms from the join
click (except in the waiting room) until first media arrives, then every 5 s, so
first-media times are stamped at the first sample that shows them, even when
media arrives before the join finishes. Totals start at `joined`: the first
sample after it is only a baseline, and totals add deltas over measured
intervals from there, so nothing from before `joined` is charged to the call. A
gap of more than 15 s between readable samples is left out of every total. A
stream or camera layer counts only against its reading in the previous sample,
so one that drops out of a report and comes back starts again from a new
baseline; a remote stream first seen mid-call started since then and counts
from zero.

### `call_join`

| Property | Meaning |
| --- | --- |
| `outcome` | `joined`, `failed`, or `abandoned` (left or closed the tab before getting in). An error while the reconnect loop runs is a failed retry, not the outcome: the attempt fails only when reconnecting gives up. A redirect to another SFU is not a reconnect. A retry after a give-up starts a new attempt when it begins (`reconnecting`), so `join_ms` includes any media wait and a retry that fails early still reports |
| `failure_reason` | `rejected`, `invite_code`, `room_not_found`, `room_unavailable`, `auth`, `timeout`, `permission_denied`, `media_error`, `transport_error`, `connection_failed`, `unknown`; null unless failed. Taken from the error's own `reason` where the code knows the cause (a connect timeout is `timeout`), so rewriting the message for the user cannot change it |
| `join_ms` | Click to outcome |
| `waited`, `waiting_ms` | Whether the waiting room held the user, and for how long, up to the moment the server let them in (`joinApproved`, or a join accepted after the room unlocked during a drop), before media is set up. A drop while waiting keeps the clock running |
| `join_mode` | `meeting` or `webinar_attendee` |
| `prior_failed_attempts` | Failed attempts in this tab since the last successful join |

### `call_first_media`

Sent when both first remote audio and video have arrived, or 20 s after joining.
Skipped when nobody else is in the room.

| Property | Meaning |
| --- | --- |
| `first_remote_audio_ms` | Click to the first remote audio packet; null if none |
| `first_remote_video_ms` | Click to the first decoded remote video frame; null if none |
| `join_ms` | Click to joined |
| `remote_present_at_join` | Someone else was already in the room within 3 s of joining. Filter on this for a clean time-to-media number |
| `timed_out` | The 20 s deadline passed with audio or video missing |

### `call_summary`

Sent on leave, as soon as reconnecting gives up, or with sendBeacon when the tab
closes. Errors between reconnect attempts never end a call; one call id spans every reconnect.

| Property | Meaning |
| --- | --- |
| `end_reason` | `left`, `error`, `reconnect_failed` (retries ran out), `reconnect_abandoned` (left or closed the tab while still reconnecting), `page_closed` |
| `duration_ms` | Joined to end |
| `peak_participants` | Largest roster, including the local user |
| `first_remote_audio_ms`, `first_remote_video_ms` | As above |
| `reconnect_count`, `reconnect_total_ms`, `reconnect_longest_ms` | Times the connection dropped mid-call, timed from the drop (the start of the reconnect loop, even in a hidden tab whose UI stays `joined`) until it was back |
| `reconnect_unrecovered` | The call ended while still reconnecting |
| `remote_video_ms` | Time remote video was arriving, summed over streams, in 5 s sample steps. Divide freeze and stall time by it for a rate |
| `video_freeze_count`, `video_freeze_ms` | The browser's `freezeCount` and `totalFreezesDuration` over all remote video. Chrome adds a freeze's whole duration when video resumes, so each stream adds at most the wall-clock time since it started counting, less the freeze time already counted. A stream starts counting at its baseline reading (the first after `joined`, after a dropped gap, or after a missed sample), or, when it is first seen in a measured interval, at the start of that interval. A freeze that began before the baseline counts only from it; one wholly inside the call counts in full, packet outages included, so freeze time can exceed `remote_video_ms` |
| `video_stall_count`, `video_stall_ms` | Intervals where bytes arrived but no frame decoded (the freeze watchdog's signal). mediasoup's padding-only probator stream is ignored |
| `audio_concealed_pct` | Share of remote audio samples the browser had to conceal |
| `outbound_video_ms` | Time the camera was sending. Screen sharing is not counted |
| `outbound_low_ms`, `outbound_standard_ms`, `outbound_profile_switches` | Time in each publish profile and how often it changed |
| `outbound_video_kbps`, `outbound_video_height` | Average send bitrate, and the frame height sent for the longest time |
| `outbound_cpu_limited_pct`, `outbound_bandwidth_limited_pct` | Share of send time the encoder was limited, from `qualityLimitationDurations`: once per sample interval, the most any layer shows, never more than the interval |

The `meet_*` events (reconnect attempts, consumer recovery and so on) are
listed in `lib/telemetry-schema.ts` with the form of each field, and none
carries a room or user id. Their reasons are fixed codes, never log or server
text: join and reconnect failures carry a `failure_reason` category;
`meet_turn_relay_activated` names which transport gave up on STUN-only ICE
(`producer_ice_unrecovered`, `producer_ice_failed`, `consumer_ice_unrecovered`,
`consumer_ice_failed`); `meet_consumer_resume_exhausted` says why the last
resume failed (`ack_timeout`, or the SFU's `displaced` or `rate_limited`, else
`server_error`); and `meet_stale_consumer_*` say what found the stale consumer
(`resume_retries_exhausted`, `server_lost_consumer`, `consumer_stayed_muted`,
`decoder_frozen`, `muted_live_track`).

## Privacy

The browser sends its events to `/ingest` on our own site (`app/ingest/[...path]/route.ts`,
`lib/telemetry-ingest.ts`), never to PostHog. The route takes only the event
endpoint (`/ingest/e/`) as a POST of at most 256 KB, 1 MB once decoded, and 200
events, labelled with a content type posthog-js sends (`application/json`,
`text/plain` or `application/x-www-form-urlencoded`). Before it reads the
body it takes a rate limit (`lib/ingest-rate-limit.ts`), the same mechanism
as `/api/unfurl`: 120 requests a minute per client (keyed by
`cf-connecting-ip`) and 6000 a minute for the whole site, through the
`INGEST_RATE_LIMITER` and `INGEST_GLOBAL_RATE_LIMITER` bindings in
`wrangler.jsonc`. A client over either limit gets 429 with `Retry-After: 60`,
which the outbox already honours. On Cloudflare a missing or failing binding
answers 503; off Cloudflare (`next start`) the same two limits are kept in
the process. It decodes the body
(gzip, base64 or JSON), drops events for any project but ours, and builds
every event again from the outbound schema, so the
browser's before_send is not the only guard. A request carries one build, the
first event's `client_version`; events naming any other build are dropped, so
a request costs at most one manifest lookup. That build's chunk manifest is
fetched from our configured site (`lib/site-url.ts`, never the request's Host)
with `?dpl=<build>` (a version that is not a git sha is never fetched), shared
by concurrent requests, and kept for 10 minutes, or 1 minute when missing, for
the 16 most recently used builds. A manifest load has 2 s, its body included;
one that fails or runs out of time falls back to the last manifest read for
that build (a build's manifest never changes), or to none. A tab still running
an older build, or a saved batch from one that a newer page replays, is
judged by its own manifest, not the newest one. When this deployment has no
manifest for that build (a fresh instance after a cutover answers 404 for an
old one), the build is still named and each frame keeps its chunk id and file
only when both pass the shared forms (a uuid, and a same-origin
`/_next/static/...js` path with no query and no `.` or `..` segment); what
fails a form is stripped, so old reports keep their stacks without old
manifests. It forwards the batch to PostHog as
plain JSON with the fixed User-Agent `conclave-web-ingest/1` and no header of
the browser's: no cookie, no IP address and no forwarded or referrer header
reaches PostHog. `/ingest` waits at most 10 s for PostHog, and reads
PostHog's answer through the same table as the outbox: delivered is 200; worth
sending again, or no answer in time, is 503, with PostHog's `Retry-After` (in
seconds, at most 60) when it gave one; refused is 400. Each event is
checked on its own, every field of it (uuid, timestamp, project, build,
time and outbound schema), so one malformed event never takes the others
down: the sound events are forwarded, and the answer lists the index of
each event that will never be taken (`{"status":1,"rejected":[...]}` on
200, `{"rejected":[...]}` on 503), with nothing about why. The outbox
drops exactly those events from the batch and keeps the rest for the next
try. A body that is not a capture body at all, or one with no event that
could be taken, gets 400 with an empty body, so the browser drops it and
learns nothing of what failed.

Both the browser's `before_send` and `/ingest` build each event from scratch
through the outbound schema in `lib/telemetry-schema.ts` (`buildOutboundEvent`
in `lib/telemetry-privacy.ts`). The schema lists every event, every property
each may carry, and the form of each value: an enum, a constant, a bounded
number or an id we generated, never free text. Nothing else in an event is read,
at any depth, and a value that does not fit its form is dropped, that value
alone: an exception keeps its other fields when one frame position is out of
range, and its first 50 entries and 500 frames per entry. The scrubber only
shapes the values of listed properties:

- **Events.** Only the listed events are sent. posthog-js's own (`$pageview`,
  `$identify` and the like) and any other name are dropped.
  `telemetry.capture` and `telemetry.captureException` take each event's fields
  by its schema, so a call site that passes a field it does not list, or text
  where a code belongs, does not compile.
- **Fields we set.** `$host` is always `conclave-web`, `token` is our project
  key, `$lib` is `web` and `$process_person_profile` is false. `client_version`
  is the browser's own build. `/ingest` keeps it whenever it has a build's
  form (7 to 40 hex characters), whether or not this deployment still has
  that build's chunk manifest, and sends `unknown` otherwise.
- **Our fields** come only from the payload of the capture that sent them,
  never from the event, so nothing in local or session storage can supply one.
  An event the SDK raised itself, such as an unhandled error, carries none.
- **SDK fields** never come from storage: the only stored values sent are the
  SDK's own ids (`distinct_id`, `$device_id`, `$session_id`, `$window_id`), and
  only as uuids. On load, `lib/telemetry.ts` removes everything but those ids
  from both stores. The parsed browser, its version, the OS (its version only
  as a version number), the device type, screen and viewport sizes, the time
  zone offset and the posthog-js version are sent; the browser language only as
  its primary subtag from the ISO 639-1 list (`en-US-x-labunit` goes out as
  `en`). The referrer, the session's entry page, the raw user agent, the time
  zone name and the SDK's debug fields are not. Person properties (`$set`,
  `$set_once`) are never sent, and `save_campaign_params` is off.
- **URLs.** `$current_url` and `$pathname` are the route alone (`/[code]`,
  `/w/[code]`), with no origin, query or hash.
- **Exception messages.** A message is sent only when it is a registered
  `[Meets]` call-log label from the capture's own payload. Every other one,
  from an engine, a library, the server or a rejected value, becomes
  `[message withheld]`. Type names are kept only from a list of known error
  kinds (built-in, DOM, ours); any other, such as a rejected object's `name`,
  becomes `[type withheld]`.
- **Stack frames** keep only their file, line, column, in-app flag and a chunk
  id the build's manifest lists. Function names are dropped; source maps
  restore them in PostHog. A frame's file is a path, never an origin, and only
  for a script our own site served that is one of the exact files under
  `public/` (a test keeps that list equal to the folder), or a build chunk whose
  frame carries a chunk id the build's manifest maps to that very file; any
  other file is `[path]`. `cf:build` writes each build's manifest at
  `/_next/static/posthog-chunk-ids/<build>.json` (the build's git sha) right
  after `posthog-cli sourcemap inject`, and the page loads its own at startup.
  An id the build never produced, or a real id on another file, proves nothing,
  so until the manifest loads, and in a build without one, chunk frames are
  `[path]`.
- **Times.** Each event's uuid and timestamp are fixed when it is captured
  (a report held for the SDK or the chunk manifest keeps the time it was
  made), stored with its batch, and never computed again, by the browser or
  by `/ingest`: `/ingest` forwards the event's own timestamp string
  unchanged. It takes an event only when that time lies within 5 minutes
  before receipt (or a minute after), or when the browser's own send time
  says the event is at most 5 minutes old (a skewed clock is judged against
  itself); any other event is refused, and so is one with no uuid or no
  timestamp. A browser whose clock is off therefore reports its own clock's
  time. The browser's send time is not forwarded.
- **Retries.** `/ingest` keeps every event it forwarded by uuid (the last
  10,000, within 4 MB) and checks that first: a retry, or an event sent again,
  is forwarded exactly as the first delivery was, without being built again,
  and an event PostHog already took is not forwarded at all (a request of
  only those is answered 200). One request naming a uuid twice forwards it
  once, and a request naming a uuid whose forward is still in flight on the
  same instance waits for that forward instead of sending it again, and takes
  its whole answer. Every answer from `/ingest` is built from what happened
  to each event in the request (its own forward, a forward it shared, an
  event PostHog already took, or a refusal): if any is worth sending again
  it is 503 with the longest `Retry-After` any of them was given; every event
  refused for good is listed; it is 200 when any event went, else 400. Across instances (two isolates, or one started
  after a cutover) an event can reach PostHog twice; since its uuid and
  timestamp are the same every time, PostHog folds the duplicates on uuid
  plus timestamp.
- **Required fields.** An `$exception` with no exception list, or an empty
  one, is not sent.
- **Guest pass identifiers.** No event carries a guest pass id (`gp_` and 22
  characters), a guest seat key (`guest-gp_...`, or an older
  `guest-<sessionId>`), a pass cookie (`conclave-guest-<scope>-<slot>`) or a
  signed pass, grant or join token (these are what carry `guestProof`): the
  outbound schemas have no field that could hold one, and as a last check
  the browser and `/ingest` (`buildOutboundEvent`) and the SFU
  (`createOutboundEvent`) refuse any built event whose content still names
  one, by the shapes in `@conclave/meeting-core/guest-pass-identifiers`. A
  chunk-shaped frame path that embeds a pass id, which a frame keeps when its
  build's chunk list is not at hand, is refused that way. Telemetry requests
  send no cookies, so a pass cookie never reaches `/ingest` either.

Session replay, surveys, DOM autocapture, feature flags and pageviews are off,
and no user is ever identified.

The SFU's posthog-node client builds every event the same way, through the
outbound schema in `server/analytics/outbound.ts` (its `beforeSend`). The
schema lists each event it sends (`$exception`, `$groupidentify` and the
`game_*` events), the form of its distinct id, every property and the form of
each value; anything else, at any depth, is dropped, and so is any other event.
Game ids and options come from the game registry: a number option only within
its bounds, a select only as one of its choices, a text option only as whether
it was set. The exception shaping follows the same rule as the browser's: a
thrown or rejected value that is not an Error is reported as `NonErrorValue`;
type names are kept only from a known list; a message is sent only for a real
instance of our constant-message classes (`ConfigError`, which names the
variable and never its value, and `NonErrorValue`), checked with `instanceof`
when the error is reported and never by its name. Otherwise it is
`[message withheld]`, keeping just a Node errno code read from the error's own
`code` (`ECONNREFUSED` and the like), whatever its message says. Frames lose the
source lines and module names posthog-node attaches, and keep a path and a
function name only for an in-app frame of our own source: a file that exists
inside the SFU's own folder (`packages/sfu`) and is not under `node_modules`,
sent relative to that folder. Any other frame, a library's, a Node internal, a
home folder or a name that only looks like ours, is `[path]` with function `?`.
Game events group by a keyed hash of the room (`room_<hmac>`), never its code.
Without a real `SFU_SECRET` they are not grouped at all, and distinct ids use a
key that lives only in that process.
