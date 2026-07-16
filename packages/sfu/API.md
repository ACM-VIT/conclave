# SFU Admin Controls

This document describes the SFU admin control-plane (HTTP + Socket.IO) implemented in `packages/sfu`.

## Authentication

HTTP admin endpoints require:
- Header: `x-sfu-secret: <SFU_SECRET>`

Optional room disambiguation header/query (when multiple clients can have the same room id):
- Header: `x-sfu-client: <clientId>`
- Query: `?clientId=<clientId>`

Socket admin events require the caller to be an active room admin/host.

## Identity Model (Important)

Access-control endpoints use `userKey`, not session-scoped `userId`.

From server identity logic:
- `userKey` = token `email` or token `userId`
- `userId` = `${userKey}#${sessionId}`

This means:
- Allow/block lists should store stable identity keys (email/userId), not session ids.
- Pending room entries are keyed by `userKey`.

## HTTP Admin Endpoints

Base routes live in `packages/sfu/server/http/createApp.ts`.

### Health/Status

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | process health + worker health |
| GET | `/status` | instance status |
| GET | `/routing/rooms/:clientId/:roomId` | resolve an owner or in-flight placement |
| POST | `/routing/placements/:clientId/:roomId` | atomically reserve a bounded first-room placement |
| POST | `/drain` | toggle draining and optionally force-drain |
| POST | `/admin/drain` | alias of `/drain` |

### Draining + Multi-SFU Join Routing

To let new meetings move from SFU A to SFU B while A drains:

- Run all SFUs with the same `SFU_SECRET`.
- Run all SFUs against the same Redis room registry (`SFU_REDIS_URL` or `REDIS_URL`) so room ownership is shared.
- Give each SFU a globally unique `SFU_INSTANCE_ID` and a direct public
  `SFU_PUBLIC_URL`. The URL must address that one process/instance, not a load
  balancer shared by multiple SFUs; the pair is part of ownership identity.
- Configure the web app join endpoint with every SFU URL:
  - `SFU_URLS=https://sfu-a.example.com,https://sfu-b.example.com`
  - or `SFU_POOL=sfu-a=https://sfu-a.example.com,sfu-b=https://sfu-b.example.com`
- Keep that candidate pool identical across every deployed web worker so each
  can validate and follow the same atomic winner.
- Mark the old SFU draining with `POST /drain {"draining": true}` or `SFU_DRAINING=1`.

The web `/api/sfu/join` endpoint still routes existing rooms to their recorded owner. For a room with no owner yet, it skips SFUs whose `/status` reports `draining: true` and chooses a non-draining instance.

### Regional Placement

`docker-compose.sfu.yml` runs `sfu-a` and `sfu-b` on the same host and the same
announced IP. That topology is blue/green redundancy; it does **not** provide
geographic routing or reduce media round-trip time.

For genuinely regional media paths, deploy at least one SFU host in each
geography. Every regional host needs its own publicly reachable UDP address and
port range, while every SFU in the pool must use the same Redis room registry.
Set a stable region identifier on each instance:

- `SFU_REGION=me-central-1`
- `SFU_REGION=eu-west-1`

The authenticated `/status` response exposes the normalized `region` (or
`null` when it is not configured). Configure the web join service with all
regional public SFU URLs. It probes candidates server-side, prefers healthy
capacity close to the requesting edge, and atomically reserves a 20-second
first-room placement in Redis. The selected SFU atomically converts that
placement into the longer-lived room owner when it creates the mediasoup room.
Every later participant follows that stored assignment, even when a
different region would be closer to that individual participant.

Regional production deployments must fail closed for new room placement when
the shared registry is unavailable. Falling back to independent per-process
ownership can split one meeting across SFUs. Existing rooms may continue only
inside their last confirmed Redis lease; they are fenced and closed before
that lease can expire. No new placement or owner is guessed until the shared
registry recovers. A multi-SFU web pool rejects a process-local placement
registry; local mode remains supported for a true singleton SFU.

Keep `SFU_ROOM_REGISTRY_TTL_MS` comfortably above twice
`SFU_ROOM_REGISTRY_RENEW_INTERVAL_MS` plus the Redis command deadline. The SFU
refuses an unsafe Redis lease configuration at startup rather than risk serving
past a shared ownership lease.

For a rolling release, deploy the placement-aware SFUs before the web join
service. Only add multiple regional URLs to the web pool after every candidate
serves the placement endpoint and shares the same Redis registry.

#### Fail-closed deployment preflight

The rolling deploy scripts now run a read-only preflight before `git pull`, a
container build, or a drain request. Run that preflight without deploying:

```bash
./scripts/deploy-sfu.sh --preflight-only
# Equivalent spelling:
./scripts/deploy-sfu.sh --dry-run
```

The PowerShell script accepts the same flags. These commands render the Compose
configuration locally and make only `GET /health` and authenticated
`GET /status` requests to each configured public SFU origin. They never pull
code, build or restart a container, change DNS, or call a mutating SFU route.
The run fails when any SFU is unhealthy or when its public route reports a
different instance ID or region.

The preflight also fails before making a request when:

- an instance ID or public URL is missing or duplicated;
- a region is missing or malformed;
- a non-local public URL is not HTTPS or its `ANNOUNCED_IP` is not a public IP
  literal;
- `SFU_REQUIRE_REDIS_ADAPTER` is not enabled, Redis is missing, or candidates
  point at different Redis endpoints/databases; or
- an RTC port range is invalid, reversed, or overlaps another SFU on the same
  announced IP.

For the included Compose pair, configure `SFU_A_PUBLIC_URL`,
`SFU_B_PUBLIC_URL`, `SFU_A_REGION`, `SFU_B_REGION`, `ANNOUNCED_IP`,
`SFU_REQUIRE_REDIS_ADAPTER=1`, and `SFU_REDIS_URL` (or `REDIS_URL`). A local
configuration-only check that makes no HTTP requests is also available:

```bash
./scripts/deploy-sfu.sh --preflight-config-only
```

The checker itself is not tied to `sfu-a` and `sfu-b`: it discovers Compose
services carrying `SFU_INSTANCE_ID`, or accepts a comma-separated override in
`SFU_DEPLOY_SERVICES`. The current rolling orchestrator still deploys the
included two-service Compose pair; regional hosts can reuse the checker with
their own named Compose SFU services.

### Room-wide Webcam Codec Negotiation

Clients declare webcam capability version 3 in `joinRoom`:

```json
{
  "mediaCapabilities": {
    "webcam": {
      "negotiationVersion": 3,
      "receive": ["vp8", "h264-cb", "vp9-p0"],
      "send": ["vp8", "h264-cb", "vp9-p0-l2t1"],
      "preferredBaseline": "vp8"
    }
  }
}
```

The SFU returns `webcamCodecPolicy` from `joinRoom` and emits
`webcamCodecPolicyChanged` with a monotonically increasing `epoch`. Webcam
producers are accepted only when their actual RTP parameters match that epoch's
policy, both before and after asynchronous mediasoup producer creation.

- VP9 is selected only when every participant can receive profile 0 and every
  potential publisher explicitly supports one `L2T1` SVC encoding. Legacy
  version-1 `vp9-p0-l3t1-key` declarations (and older L3T3 declarations) are
  not upgraded implicitly and fail closed to VP8.
- H.264 requires constrained baseline with packetization mode 1. It is selected
  for H.264-sensitive publishers only when the whole room can use it.
- Missing, legacy, malformed, or incompatible declarations fail closed to VP8.
- The active Skip client declares receive VP8/H.264 and send VP8. A native
  publisher therefore keeps the room on VP8; a receive-only native viewer can
  still coexist with a compatible H.264 publisher.

A compatibility downgrade closes only webcam producers outside the new policy;
clients then republish under the new epoch. Efficiency upgrades are deferred
while a webcam is active so participants joining or reconnecting do not churn a
healthy call. `updateMediaCapabilities` is monotonic and rate limited.
Web clients make an initial desktop VP9 claim only when the handler/static RTP
intersection supports profile 0 and that browser/device has no session-cached
encoder failure. They confirm the intersection again after `Device.load` and
before publishing. `reportWebcamCodecFailure` accepts a current-epoch VP9 failure once per bounded
rate-limit window and removes only that client's VP9 sender claim, causing the
same safe room-policy reconciliation. Clients must use this only for proven
local encoder incompatibility or a reproduced zero-frame VP9 stall—not for
transport, ICE, signaling, timeout, or generic network failures.

### Producer Transport Network Profiles

An active participant may emit the acknowledged
`setProducerTransportNetworkProfile` socket event with its current producer
`transportId` and a `good`, `fair`, `poor`, or `emergency` profile. The SFU
maps that profile to a transport-wide `maxIncomingBitrate` ceiling and returns
the applied profile, transport ID, and exact bitrate. This lets mediasoup's BWE
control a stable VP8 simulcast sender without a live browser
`RTCRtpSender.setParameters()` transaction.

The event is rejected for observers, stale or closed transports, malformed
profiles, and rate-limit overflow. A client that has already received a valid
acknowledgement should retain the last safe server ceiling and retry transient
failures; sender-level caps are only a compatibility fallback for servers that
do not support the event.

### Cluster/Workers/Rooms

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/overview` | cluster-level counts and state |
| GET | `/admin/workers` | per-worker resource usage snapshot |
| GET | `/admin/rooms` | room snapshots (optionally by client id) |
| GET | `/admin/rooms/:roomId` | single room snapshot |

### Room Policy + Lifecycle

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/rooms/:roomId/policies` | set lock/chat/noGuests/tts/dm flags |
| POST | `/admin/rooms/:roomId/notice` | broadcast `adminNotice` |
| POST | `/admin/rooms/:roomId/end` | end room, emit `roomEnded`, disconnect clients |

### Media / User Moderation

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/rooms/:roomId/producers/:producerId/close` | close a specific producer |
| POST | `/admin/rooms/:roomId/users/:userId/kick` | kick one user |
| POST | `/admin/rooms/:roomId/users/:userId/media` | close selected media kinds/types |
| POST | `/admin/rooms/:roomId/users/:userId/mute` | shortcut: close audio producers |
| POST | `/admin/rooms/:roomId/users/:userId/video-off` | shortcut: close webcam video |
| POST | `/admin/rooms/:roomId/users/:userId/stop-screen` | shortcut: close screen-share producers |
| POST | `/admin/rooms/:roomId/users/remove-non-admins` | kick all non-admins (optional attendees) |
| POST | `/admin/rooms/:roomId/users/:userId/block` | block identity and kick active session |
| POST | `/admin/rooms/:roomId/users/:userId/unblock` | unblock identity |

### Access Control (Allow/Block Specific People)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/rooms/:roomId/access` | show allow/locked-allow/block lists |
| POST | `/admin/rooms/:roomId/access/allow` | allow specific `userKey` identities |
| POST | `/admin/rooms/:roomId/access/revoke` | revoke allowed identities |
| POST | `/admin/rooms/:roomId/access/block` | block identities (optional kick) |
| POST | `/admin/rooms/:roomId/access/unblock` | unblock identities |

### Waiting Room Controls

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/rooms/:roomId/pending/:userKey/admit` | admit one pending user key |
| POST | `/admin/rooms/:roomId/pending/:userKey/reject` | reject one pending user key |
| POST | `/admin/rooms/:roomId/pending/admit-all` | admit all pending |
| POST | `/admin/rooms/:roomId/pending/reject-all` | reject all pending |

### Hand Controls

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/rooms/:roomId/hands/clear` | clear all raised hands |

## Socket Admin Events

Base handlers live in `packages/sfu/server/socket/handlers/adminHandlers.ts`.

### Existing + Extended

- `kickUser`
- `closeRemoteProducer`
- `muteAll` (extended options)
- `closeAllVideo` (extended options)
- `promoteHost`
- `redirectUser`
- `admitUser`
- `rejectUser`
- `lockRoom`
- `setNoGuests`
- `lockChat`
- `setTtsDisabled`
- `setDmEnabled`
- status getters (`getRoomLockStatus`, `getChatLockStatus`, `getTtsDisabledStatus`, `getDmEnabledStatus`)

### Added Diagnostics / Control

- `admin:getRoomsDetailed`
- `admin:getRoomState`
- `admin:getParticipants`
- `admin:getPendingUsers`
- `admin:getAccessLists`
- `admin:transferHost`
- `admin:setPolicies`
- `admin:broadcastNotice`
- `admin:endRoom`
- `admin:closeRoom`

### Added Media Moderation

- `admin:closeUserMedia`
- `admin:muteUser`
- `admin:closeUserVideo`
- `admin:stopUserScreenShare`
- `admin:stopAllScreenShare`
- `admin:muteUserAudio`

### Added Access-List Socket Controls

- `admin:allowUsers`
- `admin:blockUsers`
- `admin:unblockUsers`
- `admin:revokeAllowedUsers`
- `admin:admitAllPending`
- `admin:rejectAllPending`
- `admin:clearRaisedHands`

## Runtime Enforcement

Blocked identities are denied at join time for non-admin joins.

- Join guard location: `packages/sfu/server/socket/handlers/joinRoom.ts`
- Room allow/block primitives: `packages/sfu/config/classes/Room.ts`

## Example Requests

### Allow specific identities into a room

```bash
curl -X POST "http://localhost:3031/admin/rooms/room-123/access/allow?clientId=default" \
  -H "content-type: application/json" \
  -H "x-sfu-secret: development-secret" \
  -d '{"userKeys":["alice@example.com","bob@example.com"],"allowWhenLocked":true}'
```

### Admit one specific pending user key

```bash
curl -X POST "http://localhost:3031/admin/rooms/room-123/pending/alice@example.com/admit?clientId=default" \
  -H "x-sfu-secret: development-secret"
```

### Block identity and kick active session

```bash
curl -X POST "http://localhost:3031/admin/rooms/room-123/access/block?clientId=default" \
  -H "content-type: application/json" \
  -H "x-sfu-secret: development-secret" \
  -d '{"userKeys":["spam@example.com"],"kickPresent":true,"reason":"Policy violation"}'
```

### Remove all non-admin participants

```bash
curl -X POST "http://localhost:3031/admin/rooms/room-123/users/remove-non-admins?clientId=default" \
  -H "content-type: application/json" \
  -H "x-sfu-secret: development-secret" \
  -d '{"includeAttendees":true,"reason":"Stage reset"}'
```

### End room

```bash
curl -X POST "http://localhost:3031/admin/rooms/room-123/end?clientId=default" \
  -H "content-type: application/json" \
  -H "x-sfu-secret: development-secret" \
  -d '{"message":"Session ended by moderator","delayMs":2000}'
```

## Notes

- `pendingUsersSnapshot` remains backward-compatible (`userId` is still `userKey`).
- Room snapshots now include `access` lists and richer participant diagnostics.
- If room id is ambiguous across tenants, pass `clientId` in header or query.
