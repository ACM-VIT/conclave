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

### Guest identities

A participant can read every `userKey` and `userId` in the room, so a guest key is not a credential.
The web app issues each browser a guest pass in an HttpOnly cookie. A page asks for it as it loads (`POST /api/guest-pass`), and the join route (`apps/web/src/app/api/sfu/join/route.ts`) issues one to a caller that has none.
The guest `userKey` is a keyed hash of the pass, the room id the join asked for, and the tab's session id: `guest-gp_<hash>`.
The same browser gets a different key in every room and tab, and the key does not reveal the pass.
A client learns its own `userKey` from the join token.
The token names the room the key was issued for in `guestRoom`, and the SFU lets it join no other room. Tokens without that claim, from signed-in users and from older clients, join as before.

The route also signs a `guestProof` claim into the join token. `guestProof` is a keyed hash of the pass alone, so it is the same in every room and tab. The SFU never sends it to clients.

The SFU binds a guest `userKey` to the `guestProof` it enters a room with. The binding lasts while the key holds anything in the room: a seat, a waiting-room entry, host, an admission, a stage invite, a block, or a refusal recorded under the key.
A later join under that `userKey` must carry the same `guestProof`. Otherwise the SFU refuses the join.

The proof is how the SFU treats two keys as one guest. What a guest may do does not depend on the tab:

- A right that one key of a guest holds in a room holds for every key of that guest: host, co-host, and an admission past the waiting room or the lock. A second tab in the host's browser joins as a host. Removing a guest, or revoking its admission, ends the right for every one of its keys.
- This applies to tokens issued for the room (`guestRoom`). A token with no `guestRoom` holds only what its own key holds.
- Blocking a guest removes and keeps out every other key of the same guest, so the guest's other tabs leave too. A block covers any token that presents the proof. The guest stays out while any of its keys is on the block list.
- A block wins over every right. A join is checked against the block list before host, co-host, an admission or a stage invite is looked at. Blocking a guest also ends those rights for all of its keys. When the room learns that a blocked key and other keys are one guest, it ends their rights and removes every seat and waiting request of that guest. The one exemption is an account that is a host by configuration outside the room (a super admin or forced host), which the room refuses to block or remove.
- A blocked guest never holds host or co-host rights. No seat of a blocked guest is made a host, by a host or when the room is handed on, and lifting the block gives no right back: only a host who promotes the guest afterwards does. A removal takes out every seat it covers before the room is handed on, and then hands it on once, never to a guest that is blocked or that the removal took out.
- The lobby shows hosts one request per guest. A guest who waits in more than one tab, under one pass or under linked passes, is one row, shown under the key of its oldest waiting tab. Admitting that row lets in every waiting tab of the guest, and denying it turns every one away. When the tab whose request was shown leaves, hosts are shown the guest's next waiting tab in its place.
- A stage invite and a move back to the audience are decisions on the guest, kept in the same record as admissions. An invite holds under every linked pass until it expires, so the guest's stage tab is let in whatever key it comes back under. A move back to the audience takes every stage tab of the guest off the stage at once, ends every invite the guest holds, and keeps every key of the guest off the stage until a newer invite; nothing else ends it.

A browser can hold more than one pass, when several of its first requests were each answered before any cookie had arrived. Every pass has a cookie of its own and the browser keeps them all. It goes by the lowest pass id, so every tab and every request picks the same pass, whatever order the passes arrived in. A tab may still have joined under another one. The route therefore signs `guestWas` into the token: for every other pass among the browser's cookies, the key this tab would hold under it in this room, with that pass's proof. The SFU decides a join on those passes (a block or a demotion under any of them refuses it) and records them as one guest only when the join is let in or waits. The room keeps a pass it has bound, and the passes it linked to it, for as long as the room lasts, so a guest that left and comes back under a pass that shows the earlier one is linked to it again. A refused join records nothing: no pass, no link, no binding. A room links at most 16 passes as one guest; a join that would link more is decided on its own pass, and no linked pass is dropped to make room. A room keeps at most `SFU_WAITING_REQUEST_LIMIT` requests waiting at once and `SFU_MEETING_SEAT_LIMIT` seats in a meeting (1000 each; webinar attendees have their own limit). A new request or seat past either is refused, and a tab coming back to its own request or meeting seat, or a host, is not; a tab that moves from the audience to the meeting takes a new meeting seat. It also replaces the seat the tab held under its old key, whatever that seat's socket looks like, and withdraws a request to be let in that the tab made under its old key. A transcript relay that a replaced seat controls passes to the new seat, and so does one whose seat a rejoin under the same key replaces after its socket dropped. When the tab comes back as a webinar attendee, who cannot control a relay, the relay stops instead. A tab has one seat, or one request in the lobby.

A token names up to 15 other passes. A browser that sends more is logged by the route. The token then names the lowest pass, the passes the tab says it has joined under (`guestJoinedAs` in the join request, a hint that proves nothing by itself), and the lowest of the rest.

The room's apps (`SFU_APPS_AUTHORITY_ENABLED`) see a guest whose pass the room has bound as one verified person. Its identity comes from the first pass the room saw among the passes it links as that guest, so it stays the same when a tab comes back under another pass, when a later join links the guest's passes, and when the guest leaves and comes back under any of them. The room keeps these identities for as long as it lasts, apart from the bindings of seat keys, which it still drops. A guest the room holds no pass for, such as one whose token carries no `guestProof` or whose key first came in without one, stays unverified.

Only the HttpOnly pass cookies vouch for `guestWas`. A copy of a join token is not enough to be taken for its guest under another pass.

The guest claims of a join token (`userId`, `guestProof`, `guestRoom`, `clientId`, `sessionId`, `guestWas`) have one schema, in `@conclave/meeting-core/guest-join-claims`. The route signs what that schema parses, and the SFU reads the token through it. A guest token whose claims do not parse is refused.

Who may come in is decided from one record of host decisions, kept per pass (for seat keys) or per key (for accounts and keys a client chose itself), on the same clock as requests to be let in (`config/classes/AdmissionLedger.ts`). There are no separate allow lists. A room keeps decisions for up to `SFU_LOBBY_DECISION_RECORD_LIMIT` passes and keys (5000). When it is full it drops the least recently active record that holds only admissions, never one that holds a refusal, so trimming can only make a guest knock again. When only refusals are left, a refusal is still kept and a new admission is not, and the SFU logs it.

- A join may pass the lock, or the waiting room, only if the latest decision for that scope across everything the join speaks for is an admission. For a token issued for the room that is every linked pass of the guest; for any other token it is its own key. An admission, a denial, a revocation, a removal and a block are all decisions; a later one always wins. Every refusal a host makes is recorded, whether or not the pass or key had a record before, and also against the pass when a proof ties a key a client chose itself to one. Locking the room starts lock admissions afresh.
- Only a host's decision adds a record. Nothing a participant does adds one: an attendee who declines a stage invite uses it up and leaves no refusal, a decline without an invite changes nothing, and a join that links passes to a blocked guest ends what the existing records hold and turns the guest's seats and requests away without recording anything.
- A waiting request is answered only by a decision made after it arrived. When a join links passes, the guest's waiting requests are judged again: a later denial turns a request away, a later admission lets it in if the guest still holds it, and any other request stays. Applying an earlier decision records nothing new, so the decision keeps its time.
- After every change to who waits, the SFU tells hosts the difference between the rows they were shown and the rows that are now true: removals (`userAdmitted`, `userRejected`, `pendingUserLeft`) and additions (`userRequestedJoin`). `pendingUsersSnapshot` and the admin counts come from the same rows.

A host action can admit a guest key only while the room knows who the guest is: its proof is on record, it is seated or waiting, or it is already admitted.
`admin:allowUsers` and `POST /admin/rooms/:roomId/access/allow` answer with `allowed` and `refused` key lists. When no key could be admitted the answer is a failure (`success: false` with an `error`, HTTP 409), and a block on a refused key stays. A guest the room does not know knocks and is admitted from its waiting entry. An account key, which is an email, can still be admitted ahead of time.

Two calls admit a guest the host cannot name yet:

- `admin:createAdmission` answers `{ success, admissionCode, expiresAt }`. One join that sends `admissionCode` in its `joinRoom` payload within two minutes is let in past the waiting room and the lock, and its key stays admitted until `admin:revokeAllowedUsers`.
- `Room.restoreAdmission(userKey, guestProof, { pastLock })` is for server code that vouches for a join it is deciding, such as one that presents a recovery pass after a restart. It binds the admission to the proof.

Clients that predate guest passes still send their own session id and get `guest-<sessionId>`. Such a token never names a room, and it can never name a `guest-gp_` key.
Such a client that keeps cookies proves its pass from its second join call on, and the SFU binds that identity the same way.
A guest identity that enters a room with no `guestProof` stays unbound in that room, as before guest passes.

A token minted by another service for a guest should carry a `guestProof` that only the owner of that guest identity can obtain.
## Authority Apps

`SFU_APPS_AUTHORITY_ENABLED=1` turns on the server-authoritative app runtime (`server/apps/authority`). It is off by default. With it off, no `apps:authority:*` event has a listener and the SFU answers like one that predates the runtime. The value is read once at startup: changing it needs a restart, and a process that is still running keeps the mode it started with for its rooms.

The runtime runs only the modules imported in `server/apps/authority/registry.ts`. It resolves each connection against the live room on every request and before every frame, so a removed or replaced seat receives nothing more. The wire, the guarantees and the limits are in `packages/apps-sdk/docs/reference/authority-runtime.md`.

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
