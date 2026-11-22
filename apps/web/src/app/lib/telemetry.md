# Telemetry

Conclave sends errors and call-quality numbers to PostHog. Nothing here carries
names, emails, chat text or room codes.

## Turning it on

| Where | Variable | Effect |
| --- | --- | --- |
| Web build | `NEXT_PUBLIC_POSTHOG_KEY` | Project key. Without it the browser loads nothing, reads no call stats and sends nothing. |
| Web build | `NEXT_PUBLIC_POSTHOG_HOST` | Defaults to `https://eu.posthog.com`. |
| Web dev | `NEXT_PUBLIC_POSTHOG_DEV=1` | `next dev` only sends events with this set. |
| Web deploy | `POSTHOG_CLI_API_KEY`, `POSTHOG_CLI_PROJECT_ID`, `POSTHOG_CLI_HOST` | `cf:build` builds, uploads and deletes browser source maps (needs `posthog-cli` on PATH). Read from the shell or the `.env` files `next build` reads. Other builds, `cf:preview` included, make no maps. A failed upload, or one still running after 90 s (`POSTHOG_SOURCEMAPS_TIMEOUT_MS`), warns and the deploy goes on without readable stacks; maps are always removed. |
| SFU | `SFU_POSTHOG_KEY`, `SFU_POSTHOG_HOST` | Server exceptions and game events. `SFU_POSTHOG_ENABLED=0` turns both off. Always off under vitest. |

## Exceptions (`$exception`)

Web, from `lib/telemetry.ts`. It loads PostHog when the first page mounts or
the first report arrives, and holds up to 50 reports until it has loaded:

- Unhandled errors and promise rejections (posthog-js autocapture, rate limited per error type by the SDK).
- Errors caught by `app/error.tsx` and `app/global-error.tsx`: `source: "react_error_boundary"`, `boundary: "route" | "root"`, `digest`.
- `console.error("[Meets] ...")` lines from the call code: `source: "call_log"`, `call_log` (the log label). The exception's message is the label. A logged Error keeps its type and stack frames, never its message. Other logged values are dropped. mediasoup ids in a label become `[id]`, so one failure type shares one budget: at most 3 per label and 30 in total per minute.
- Errors built from server text (socket ack `error` fields and the like) are thrown as `ServerError`, and their message leaves the browser as `[server message]`. Server text can carry words people typed, such as a host's end-room note. A lint rule flags `new Error(x.error)`.

SFU, from `server/analytics/errorReporter.ts`, every event tagged `sfu_instance_id`, `sfu_region`, `sfu_version`:

| `source` | When | Extra properties |
| --- | --- | --- |
| `uncaught_exception`, `unhandled_rejection` | The process is about to exit (level `fatal`, waits at most 2s to send) | |
| `startup_failed` | `server.start()` rejected | |
| `socket_handler` | A socket.io handler threw or rejected | `socket_event` |
| `worker_died`, `worker_respawn_failed` | A mediasoup worker died or could not be replaced | `worker_label`, `worker_pid` |
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
media arrives before the join finishes. A gap of more than 15 s between readable
samples is left out of every total.

### `call_join`

| Property | Meaning |
| --- | --- |
| `outcome` | `joined`, `failed`, or `abandoned` (left or closed the tab before getting in). An error while reconnecting is a failed retry, not the outcome: the attempt fails only when reconnecting gives up |
| `failure_reason` | `rejected`, `invite_code`, `room_not_found`, `room_unavailable`, `auth`, `timeout`, `permission_denied`, `media_error`, `transport_error`, `connection_failed`, `unknown`; null unless failed |
| `join_ms` | Click to outcome |
| `waited`, `waiting_ms` | Whether the waiting room held the user, and for how long, up to `joinApproved` (the host letting them in), before media is reacquired. A drop while waiting keeps the clock running |
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
| `reconnect_count`, `reconnect_total_ms`, `reconnect_longest_ms` | Times the call left `joined` mid-call, and how long it took to get back |
| `reconnect_unrecovered` | The call ended while still reconnecting |
| `remote_video_ms` | Time remote video was arriving, summed over streams, in 5 s sample steps. Divide freeze and stall time by it for a rate |
| `video_freeze_count`, `video_freeze_ms` | The browser's `freezeCount` and `totalFreezesDuration` over all remote video |
| `video_stall_count`, `video_stall_ms` | Intervals where bytes arrived but no frame decoded (the freeze watchdog's signal). mediasoup's padding-only probator stream is ignored |
| `audio_concealed_pct` | Share of remote audio samples the browser had to conceal |
| `outbound_video_ms` | Time the camera was sending. Screen sharing is not counted |
| `outbound_low_ms`, `outbound_standard_ms`, `outbound_profile_switches` | Time in each publish profile and how often it changed |
| `outbound_video_kbps`, `outbound_video_height` | Average send bitrate, and the frame height sent for the longest time |
| `outbound_cpu_limited_pct`, `outbound_bandwidth_limited_pct` | Share of send time the encoder was limited, from `qualityLimitationDurations` |

The older `meet_*` events (reconnect attempts, consumer recovery and so on)
still flow through `telemetry.capture`, minus their `roomId` and `userId`. Join
and reconnect failures carry a `failure_reason` category, never the error text.

## Privacy

`telemetry-privacy.ts` runs as posthog-js `before_send`. It rewrites every URL
property and stack frame URL to its route (`/[code]`, `/w/[code]`), drops query
strings, hashes, the page title and any `roomId` or `userId` property, and
replaces emails, tokens and credentials in free text: the whole value of a
`Cookie`, `Set-Cookie`, `Authorization` or `Proxy-Authorization` line, Bearer
and Basic tokens, and `password=` / `token:` style values, at any length. An
exception built from something that was not an Error (a rejected string or
object, a thrown value) sends only its kind, such as `[primitive rejection]`,
never the value. It also drops campaign and click-id
properties (`utm_*`, `fbclid`, `gclid` and friends) and the search keywords the
SDK takes from a search-engine referrer (`ph_keyword`), with their `$initial_`
and `$session_entry_` copies, and `save_campaign_params` is off. `$search_engine`
stays. Any object or array property other than `$exception_list` is dropped.
Super properties are an allowlist: on load, `lib/telemetry.ts` unregisters any
stored one that is not the SDK's own or `client_version`.
Stack frames in our own scripts (`/_next/static/`, `/mediapipe/`, the
transcript and effects worklets and so on) on the page's own origin keep their path so they can be symbolicated. URL
properties never do.
Session replay, surveys, DOM autocapture, feature flags and pageviews are off,
and no user is ever identified. The SFU scrubs emails, tokens and credentials
(any URI with user info, `password=` style assignments, auth headers) from
exception messages, cuts every URL to its origin and route (`/[code]`,
`/w/[code]`, `/[path]`), and drops the source lines posthog-node attaches to
stack frames before sending. Config errors name the variable, never its value.
Game events group by a keyed hash of the room (`room_<hmac>`), never its code.
