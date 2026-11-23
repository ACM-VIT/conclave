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
| Web deploy | `POSTHOG_CLI_API_KEY`, `POSTHOG_CLI_PROJECT_ID`, `POSTHOG_CLI_HOST` | `cf:build` builds, uploads and deletes browser source maps (needs `posthog-cli` on PATH). Read from the shell or the `.env` files `next build` reads. Other builds, `cf:preview` included, make no maps. A failed upload, or one still running after 90 s (`POSTHOG_SOURCEMAPS_TIMEOUT_MS`), warns and the deploy goes on without readable stacks. The CLI runs in its own process group, so a stalled upload is stopped with its native uploader child before the maps are removed, which they always are. Ctrl-C or SIGTERM is passed on to that group, the maps are removed, and the script exits 130 or 143. Exited (zombie) processes count as gone, for containers with no init to reap them. |
| SFU | `SFU_POSTHOG_KEY`, `SFU_POSTHOG_HOST` | Server exceptions and game events. `SFU_POSTHOG_ENABLED=0` turns both off. Always off under vitest. |

## Exceptions (`$exception`)

Web, from `lib/telemetry.ts`. It starts when the first page mounts or the
first report arrives, and from the moment the module loads every report
(`telemetry.capture`, `captureException`, and `logCallError`, whose capture is
installed then) goes into one queue of up to 50. The queue waits while the SDK
downloads and, once it has loaded, until the build's chunk manifest has too,
or 3 s have passed, so a first-render error keeps its chunk paths. Then each
report goes to the SDK, which only builds the event: `before_send` puts it in
the outbox (`lib/telemetry-outbox.ts`), and posthog-js never sends a request
of its own, so it holds no queue that a tab hidden and then frozen or dropped
would lose.

The outbox sends events to `/ingest` in batches, so a call costs a handful
of requests rather than one per event. A batch goes 5 s after its first event,
as soon as it holds 20 events, or before it would pass 48 KB (under the
browser's 64 KB budget for keepalive requests and beacons), whichever comes
first. An exception sends early, at most once every 3 s. An event is queued
once by its uuid. One table, in `lib/telemetry-answers.ts`, says what an
answer means, for the outbox reading `/ingest` and for `/ingest` reading
PostHog: 2xx is delivered; 408, 425, 429 and any 5xx are worth sending again;
anything else is refused for good. A batch with no answer, or one worth
sending again, is retried with the very same events after 2, 4, 8, 16 and
30 s, or after the answer's `Retry-After` when that is longer (seconds or an
HTTP date, held to 60 s); each send carries its own `sent_at`, so `/ingest`
can tell the events' age by the browser's clock. A batch whose retries run
out is saved, as below, for the next replay. A refused batch is dropped.
Batches go by keepalive fetch, without cookies.

The outbox owns every batch until `/ingest` answers a send of it: a batch is
queued, in flight or waiting to retry. A lifecycle flush is installed when
telemetry starts, before the SDK downloads, and stays for the page's life. On
`visibilitychange` to hidden, on `pagehide` and on `freeze`, everything still
queued, and any batch waiting to retry, goes out at once by beacon, once,
split to stay within the beacon limit. The browser allows 64 KB across all of
a page's outstanding beacons and keepalive requests, so the outbox counts them
against one 56 KB budget: a batch goes by keepalive only while it fits, and at
unload only what fits goes by beacon. Every batch not yet answered is saved
in local storage then, in flight or not, beaconed or not: a request past the
budget, which the browser cancels as the page goes away, is kept like the
rest. Each batch has its own entry, `conclave:telemetry:batch:<uuid>`, so
tabs saving at once never write over each other (at most 512 KB in all, the
oldest batches going first). A saved copy is removed only once a send of it
is answered. The next page load, and a page coming back into view, sends what
storage holds, from any tab, while holding a Web Locks lock
(`conclave:telemetry:replay`), so one tab replays at a time. A replay waits
its turn for the lock and holds it until its sends have their first answers,
or 10 s at most. A replay asked for while one runs, such as a page coming back
while its own replay still waits for an answer, runs after it, so a batch
saved meanwhile is not left for the next page load. Without the Web Locks API
two tabs may both send a batch, and `/ingest` takes each uuid once. A beacon
is never answered, so its batch is sent again then too.

Saved batches expire. `/ingest` keeps an event's own time only within 5
minutes of receiving it, so a batch whose oldest event is more than 4 minutes
old is dropped, never sent to be dated by when it arrived, whether it is
being replayed or retried. The batches one
replay drops are reported together as `telemetry_reports_dropped`: `batches`,
`events` (the reports in them), and `unsent`, the batches that had no send
which may have arrived (a beacon or a keepalive request in flight as the page
went away); those are reports lost for good.

Once the page has started to go away (hidden, `pagehide` or `freeze` seen),
every later report, such as the call summary the call tracker sends as the
page closes, goes out at once the same way, whatever state the SDK is in; so
does a report marked immediate. Held reports are built first:
through the SDK if it has loaded, with whatever manifest has loaded (none
leaves chunk frames as `[path]`); before it has, as events we build ourselves
from the outbound schema. Those carry the fields we can vouch
for without the SDK: the project token, the stored SDK id (or a new uuid), the
build, our host and the report's own fields; an exception keeps its type and,
for a call-log label, its message, but no frames. If the SDK fails to load,
reports go the same way. Only an answer to the manifest request ends the wait early: a page that
navigates away aborts that request before the `pagehide` listener runs, and
the abort must not release the reports as if the page stayed. PostHog's own
error capture starts as soon as it loads. Each report is built once, when it
is sent:

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
`text/plain` or `application/x-www-form-urlencoded`). It decodes the body
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
an older build is judged by its own manifest, not the newest one. It forwards the batch to PostHog as
plain JSON with the fixed User-Agent `conclave-web-ingest/1` and no header of
the browser's: no cookie, no IP address and no forwarded or referrer header
reaches PostHog. `/ingest` waits at most 10 s for PostHog, and reads
PostHog's answer through the same table as the outbox: delivered is 200; worth
sending again, or no answer in time, is 503, with PostHog's `Retry-After` (in
seconds, at most 60) when it gave one; refused is 400. A body that fails validation, an exception list of the wrong shape
included, gets 400 with an empty body, so the browser drops it and learns
nothing of what failed.

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
  is the browser's own build; at `/ingest` it names a build only when this
  deployment shipped it, the one it serves or one whose chunk manifest it still
  has, and is `unknown` otherwise.
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
- **Times.** `/ingest` keeps an event's own time when it lies within 5 minutes
  before receipt (or a minute after). A time outside that window moves
  nothing: the event is as old as the browser says it was when sent
  (the outbox's send time against the event's own), at most 5 minutes, or with
  no send time it is held to the window. The browser's send time is not
  forwarded.
- **Retries.** `/ingest` keeps every event it forwarded by uuid (the last
  10,000, within 4 MB) and checks that first: a retry, or an event sent again,
  is forwarded exactly as the first delivery was, timestamp included, without
  being built again, and an event PostHog already took is not forwarded at
  all (a request of only those is answered 200). One request naming a uuid
  twice forwards it once.
- **Required fields.** An `$exception` with no exception list, or an empty
  one, is not sent.

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
