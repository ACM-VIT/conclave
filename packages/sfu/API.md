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
| POST | `/drain` | toggle draining and optionally force-drain |
| POST | `/admin/drain` | alias of `/drain` |

### Draining + Multi-SFU Join Routing

To let new meetings move from SFU A to SFU B while A drains:

- Run all SFUs with the same `SFU_SECRET`.
- Run all SFUs against the same Redis room registry (`SFU_REDIS_URL` or `REDIS_URL`) so room ownership is shared.
- Give each SFU a unique `SFU_INSTANCE_ID` and a direct public `SFU_PUBLIC_URL`.
- Configure the web app join endpoint with every SFU URL:
  - `SFU_URLS=https://sfu-a.example.com,https://sfu-b.example.com`
  - or `SFU_POOL=sfu-a=https://sfu-a.example.com,sfu-b=https://sfu-b.example.com`
- Mark the old SFU draining with `POST /drain {"draining": true}` or `SFU_DRAINING=1`.

The web `/api/sfu/join` endpoint still routes existing rooms to their recorded owner. For a room with no owner yet, it skips SFUs whose `/status` reports `draining: true` and chooses a non-draining instance.

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
| POST | `/admin/rooms/:roomId/users/remove-non-admins` | kick all non-admins (optional ghosts/attendees) |
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
