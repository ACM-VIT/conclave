# @conclave/sfu

Conclave's [mediasoup](https://mediasoup.org) media server: socket.io signaling, HTTP admin control plane, scheduling and webinar services, server-authoritative games, and transcript relays.

- Entry point: `server.ts` (wraps `server/createSfuServer.ts`)
- Configuration knobs and defaults: [`config/config.ts`](./config/config.ts)
- HTTP and socket API reference: [`API.md`](./API.md)
- Server-authoritative game runtime: [`server/games/README.md`](./server/games/README.md)
- Deploy, drain, canary, and backup runbooks: [`docs/ops/sfu-deploys.md`](../../docs/ops/sfu-deploys.md), [`docs/ops/backups.md`](../../docs/ops/backups.md), [`docs/ops/staging.md`](../../docs/ops/staging.md)

## Development

```sh
pnpm -C packages/sfu run dev        # local SFU on port 3031
pnpm -C packages/sfu run typecheck  # tsc --noEmit
pnpm -C packages/sfu run test       # vitest suites + apps room model
pnpm -C packages/sfu run email:dev  # React Email preview on port 3002
pnpm run lint:workspace             # workspace ESLint (from repo root)
```

Narrow untrusted network input (`req.body`, socket payloads) once at the boundary through [`utilities/untrusted.ts`](./utilities/untrusted.ts) instead of casting to `any`. Game moves use throwing decoders in [`server/games/validation.ts`](./server/games/validation.ts).

## Container and Upgrade Notes

[`Dockerfile`](./Dockerfile) is multi-stage: compilers and pnpm stay in the build stage, while the runtime stage runs as `node` (uid 1000) with only `/var/lib/conclave` writable. `docker-compose.sfu.yml` adds a read-only root filesystem, `/tmp` tmpfs, `no-new-privileges`, and `cap_drop: ALL` (mediasoup binds ports above 1024).

- **Production env guards:** under `NODE_ENV=production`, startup refuses the default `SFU_SECRET` and requires `SFU_CORS_ORIGINS` (Compose defaults it to `https://conclave.acmvit.in`; list every web origin that uploads chat images or polls sockets). Production logs default to `warn`; set `SFU_LOG_LEVEL=info` in `.env` for join and room logs.
- **Recordings volume ownership:** older containers ran as `root`, leaving `/var/lib/conclave/recordings` (and its SQLite DB) root-owned. [`scripts/deploy-sfu.sh`](../../scripts/deploy-sfu.sh) runs a one-shot root `chown` before starting each container. Before a manual `docker compose up` on an older host, run:

```sh
docker compose -f docker-compose.sfu.yml run --rm --no-deps --user root \
  --cap-add CHOWN --cap-add DAC_READ_SEARCH --entrypoint chown sfu-a -R node:node /var/lib/conclave/recordings
```

- **Upgrading an existing host:** `git pull` to the target revision before running `./scripts/deploy-sfu.sh` so the deploy uses the updated script (and volume ownership step).
- **Fallback JSON migration:** before replacing an older container that fell back to in-layer JSON files, `deploy-sfu.sh` archives them under `CONCLAVE_FALLBACK_IMPORT_DIR/<service>/<UTC time>-<deploy id>/` owned by `node`. On startup the new SFU claims, replays in order, and marks imported files `.adopted`. Startup fails fast if a calendar token cannot be decrypted with `SFU_SECRET` or an archive directory cannot be opened.

## Control-Plane Store

Scheduling profiles, availability, event types, calendar connections, scheduled meetings, and scheduled webinars share one atomic control-plane store ([ADR 0024](../../docs/adr/0024-one-atomic-control-plane-store.md)). Every write is atomic and every read goes to the store, so peer SFUs never answer from stale local copies.

- **Backend selection:** Redis when a Redis URL is configured, otherwise SQLite on the recordings volume. Override explicitly with `CONTROL_PLANE_PERSISTENCE=redis|sqlite|json`.
- **JSON mode:** single SFU only; a lock file next to `CONTROL_PLANE_JSON_PATH` blocks a second SFU from starting on it. Legacy `SCHEDULING_PERSISTENCE`, `SCHEDULED_MEETINGS_PERSISTENCE`, and `SCHEDULED_WEBINARS_PERSISTENCE` still work if all three match; mixed values fail startup.
- **Startup checks and legacy import:** SQLite proves writability with a rolled-back test transaction at startup and exits before reporting healthy if it fails. Each start imports missing records from prior-release stores without reviving deleted records, and waits up to `CONTROL_PLANE_LEGACY_IMPORT_WAIT_MS` (default 120 s) if a peer SFU supersedes its import. SQLite commits wait at most 1 s for a peer write lock before answering `503`.

## Production Sizing, Ports, and Firewall

### Workers and App Document Threads

- Leave `SFU_WORKER_COUNT` unset on the 2-vCPU production VM so the SFU derives the count automatically. Unset it in the shell, `.env`, and `packages/sfu/.env` (`0` and blank values fail preflight and startup).
- Compose assumes two SFU instances share the host. Set `SFU_WORKER_HOST_INSTANCES=3` when staging shares that VM.
- In-call Yjs app documents run on worker threads (`SFU_APP_DOC_WORKERS`, default `1`), never on the signaling thread. Each worker claims 1 CPU of the instance's share; on a 2-vCPU VM shared by 3 instances, each instance runs 1 mediasoup worker and 1 app-doc worker.
- `SFU_APP_DOC_DEADLINE_MS` (default `500`) caps one sync/update. Updates over 256 KiB are rejected; timed-out or OOM workers are replaced and documents rebuild from accepted state. Each app-doc worker receives a V8 heap budget from one quarter of the instance's memory share (young gen 8–32 MiB, old gen 128 MiB–1 GiB).

### WebRTC Port Budget and Host Reservation

Compose defaults `SFU_WEBRTC_PORT_BUDGET` to `4` per instance. Effective budget `B = min(SFU_WEBRTC_PORT_BUDGET, (RTC_MAX_PORT - RTC_MIN_PORT + 1) - 4)`, reserving the last 4 ports for shared-browser plain RTP/RTCP. Explicit worker counts above `B` fail startup.

Before deploying, reserve the RTC range on the Linux host so outbound ephemeral sockets cannot steal WebRTC ports. Check `sysctl net.ipv4.ip_local_reserved_ports`, then persist (merging any existing ranges) in `/etc/sysctl.d/90-conclave-rtc-ports.conf`:

```ini
net.ipv4.ip_local_reserved_ports=40000-42200
```

Apply with `sudo sysctl --system` and confirm with `sysctl net.ipv4.ip_local_reserved_ports` ([Linux IP sysctl docs](https://docs.kernel.org/networking/ip-sysctl.html)).

### Firewall Split

Open public UDP and TCP for `RTC_MIN_PORT` through `RTC_MIN_PORT + B - 1`, and relay-source UDP for `RTC_MIN_PORT + B` through `RTC_MAX_PORT`. With the default budget (`B = 4`):

| Instance | Public UDP and TCP | Relay-source UDP |
| --- | --- | --- |
| `sfu-a` | `40000-40003` | `40004-41000` |
| `sfu-b` | `41001-41004` | `41005-42000` |
| Staging | `42001-42004` | `42005-42200` |

Update firewall rules before changing `SFU_WEBRTC_PORT_BUDGET` or RTC port ranges, and keep legacy ranges open until active calls drain and both instances restart.
