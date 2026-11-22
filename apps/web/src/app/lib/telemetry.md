# Telemetry

Conclave sends errors and call-quality numbers to PostHog. Nothing here carries
names, emails, chat text or room codes.

## Turning it on

| Where | Variable | Effect |
| --- | --- | --- |
| Web build | `NEXT_PUBLIC_POSTHOG_KEY` | Project key. Without it the browser loads nothing, reads no call stats and sends nothing. |
| Web build | `NEXT_PUBLIC_POSTHOG_HOST` | Defaults to `https://eu.posthog.com`. |
| Web dev | `NEXT_PUBLIC_POSTHOG_DEV=1` | `next dev` only sends events with this set. |
| Web deploy | `POSTHOG_CLI_API_KEY`, `POSTHOG_CLI_PROJECT_ID`, `POSTHOG_CLI_HOST` | `cf:build` builds, uploads and deletes browser source maps (needs `posthog-cli` on PATH). Read from the shell or the `.env` files `next build` reads. Other builds, `cf:preview` included, make no maps. A failed upload, or one still running after 90 s (`POSTHOG_SOURCEMAPS_TIMEOUT_MS`), warns and the deploy goes on without readable stacks. The CLI runs in its own process group, so a stalled upload is stopped with its native uploader child before the maps are removed, which they always are. Ctrl-C or SIGTERM is passed on to that group, the maps are removed, and the script exits 130 or 143. Exited (zombie) processes count as gone, for containers with no init to reap them. |
| SFU | `SFU_POSTHOG_KEY`, `SFU_POSTHOG_HOST` | Server exceptions and game events. `SFU_POSTHOG_ENABLED=0` turns both off. Always off under vitest. |

## Exceptions (`$exception`)

Web, from `lib/telemetry.ts`. It loads PostHog when the first page mounts or
the first report arrives, and holds up to 50 reports until it has loaded:

- Unhandled errors and promise rejections (posthog-js autocapture, rate limited per error type by the SDK).
- Errors caught by `app/error.tsx` and `app/global-error.tsx`: `source: "react_error_boundary"`, `boundary: "route" | "root"`, `digest`. A meeting panel that fails to render or load (`MeetingPanelBoundary`) reports `boundary: "panel"` while the call goes on; the panel's name is not sent.
- Call failures logged with `logCallError(label, ...details)` (`lib/call-error-capture.ts`): `source: "call_log"`, `call_log` (the label). The exception's message is the label. `label` is a `CallLogLabel`, the type of `CALL_LOG_LABELS` in `lib/call-log-labels.ts`, so an unregistered label does not compile, and a lint rule rejects `console.error("[Meets] ...")`, which would bypass it. A logged Error keeps its type and stack frames, never its message. Other logged values are dropped. At most 3 per label and 30 in total per minute.
- Errors built from server text (socket ack `error` fields and the like) are thrown as `ServerError`, so the type says where the text came from. Like every message that is not a call-log label, theirs is withheld. A lint rule flags `new Error(x.error)`.

SFU, from `server/analytics/errorReporter.ts`, every event tagged `sfu_instance_id`, `sfu_region`, `sfu_version`. The configured values are operator text, so `sfu_instance_id` is `sfu_` and a keyed hash of the instance name (also the event's distinct id), keyed with `SFU_SECRET` or, without a real one, a key that lives only in that process; `sfu_region` comes from a fixed list of cloud regions plus `local`, else `other`; and `sfu_version` is sent only as a git sha or a plain `x.y.z`, else `unknown`:

| `source` | When | Extra properties |
| --- | --- | --- |
| `uncaught_exception`, `unhandled_rejection` | The process is about to exit (level `fatal`, waits at most 2s to send) | |
| `startup_failed` | `server.start()` rejected | |
| `socket_handler` | A socket.io handler threw or rejected | `socket_event` |
| `worker_died` | A mediasoup worker died | `worker_label`, `worker_pid` |
| `worker_respawn_failed` | Its replacement failed to start. The slot keeps retrying, and attempts 1, 2, 4, 8 and so on are reported | `worker_label`, `respawn_attempt` |
| `redis_transient` | A Redis error the crash guard swallowed (level `warning`) | `process_event` |

At most 5 reports per distinct error and 60 in total per minute per instance.
The fatal report before an exit is outside that limit.

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
| `video_freeze_count`, `video_freeze_ms` | The browser's `freezeCount` and `totalFreezesDuration` over all remote video. Chrome adds a freeze's whole duration when video resumes, so each interval adds at most the video time it measured: freeze time never exceeds `remote_video_ms`, and a freeze that began before `joined` or across a dropped gap counts only from the baseline |
| `video_stall_count`, `video_stall_ms` | Intervals where bytes arrived but no frame decoded (the freeze watchdog's signal). mediasoup's padding-only probator stream is ignored |
| `audio_concealed_pct` | Share of remote audio samples the browser had to conceal |
| `outbound_video_ms` | Time the camera was sending. Screen sharing is not counted |
| `outbound_low_ms`, `outbound_standard_ms`, `outbound_profile_switches` | Time in each publish profile and how often it changed |
| `outbound_video_kbps`, `outbound_video_height` | Average send bitrate, and the frame height sent for the longest time |
| `outbound_cpu_limited_pct`, `outbound_bandwidth_limited_pct` | Share of send time the encoder was limited, from `qualityLimitationDurations`: once per sample interval, the most any layer shows, never more than the interval |

The older `meet_*` events (reconnect attempts, consumer recovery and so on)
still flow through `telemetry.capture`, minus their `roomId` and `userId`. Join
and reconnect failures carry a `failure_reason` category, never the error text.

## Privacy

`telemetry-privacy.ts` runs as posthog-js `before_send` and sends only what we
trust, instead of scrubbing what looks bad:

- **Properties.** Our own event fields are read from the payload of the
  capture that sent them, never from the event, so nothing in local or session
  storage can supply one. An event the SDK raised itself, such as an unhandled
  error, carries none. SDK fields come from an exact list checked against real
  traffic, and never from storage: the only stored values sent are the SDK's
  own ids (`distinct_id`, `$device_id`, `$session_id`, `$window_id`), and only
  as uuids. The referrer and the session's entry page live in storage, so they
  are not sent. Nor is the raw user agent, which can carry a device or fleet
  tag; the parsed browser, version and OS are. The browser language sends only
  its primary subtag, and only when it is an ISO 639-1 code (`en-US-x-labunit`
  goes out as `en`). `client_version` comes from the build. On load,
  `lib/telemetry.ts` removes everything but those ids from both stores. Person
  properties (`$set`, `$set_once`) are never sent. A new event field has to be
  added to the list to be sent.
- **Exception messages.** A message is sent only when it is a registered
  `[Meets]` call-log label from the capture's own payload. Every other one, from an engine, a library, the server or a
  rejected value, becomes `[message withheld]`. Type names are kept only from
  a list of known error kinds (built-in, DOM, ours); any other, such as a
  rejected object's `name`, becomes `[type withheld]`. Each entry is rebuilt
  from the fields posthog-js sets, and each frame keeps only its file, line,
  column, in-app flag and a chunk id the build's manifest lists; any other id,
  uuid-shaped or not, is dropped. Function names are dropped; source maps
  restore them in PostHog.
- **URLs.** Every URL property and stack frame URL becomes its origin and route
  (`/[code]`, `/w/[code]`), without query or hash. A frame keeps its path only
  for a script on the page's own origin that is one of the exact files under
  `public/` (a test keeps that list equal to the folder), or a build chunk
  whose frame carries a chunk id the build's manifest maps to that very file.
  `cf:build` writes the manifest (`/_next/static/posthog-chunk-ids.json`) right
  after `posthog-cli sourcemap inject`, and the page loads it at startup. An id
  the build never produced, or a real id on another file, proves nothing, so
  until the manifest loads, and in a build without one, chunk frames are
  `[path]`. A frame from another scheme keeps only the scheme.
- Our own string fields still go through the credential, email and token
  scrubber, and `save_campaign_params` is off.

Session replay, surveys, DOM autocapture, feature flags and pageviews are off,
and no user is ever identified. The SFU follows the same rule: a thrown or
rejected value that is not an Error is reported as `NonErrorValue`; type names
are kept only from a known list; a message is sent only for a real instance of
our constant-message classes (`ConfigError`, which names the variable and never
its value, and `NonErrorValue`), checked with `instanceof` when the error is
reported and never by its name. Otherwise it is `[message withheld]`, keeping
just a Node errno code read from the error's own `code` (`ECONNREFUSED` and the
like), whatever its message says. Frames lose the source lines and module names
posthog-node attaches, and keep a path only for an in-app frame of our own
source: a file that exists inside the SFU's own folder (`packages/sfu`) and is
not under `node_modules`, sent relative to that folder. Any other path, a
library's, a Node internal, a home folder or a name that only looks like ours,
is `[path]`.
Game events group by a keyed hash of the room (`room_<hmac>`), never its code.
Without a real `SFU_SECRET` they are not grouped at all, and distinct ids use a
key that lives only in that process.
