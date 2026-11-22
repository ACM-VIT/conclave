# @conclave/sfu

The Conclave media server: a [mediasoup](https://mediasoup.org)-based SFU with
socket.io signaling, plus the HTTP admin control plane, scheduling/webinar
services, the server-authoritative game runtime, and transcript relays.

- **HTTP + socket API reference:** see [API.md](./API.md).
- **Game runtime (server-authoritative games):** see
  [server/games/README.md](./server/games/README.md).
- **Entry point:** `server.ts` (wraps `server/createSfuServer.ts`).
- **Deploy:** built via the included [Dockerfile](./Dockerfile); configuration
  comes from `.env` (see `config/config.ts` for every knob and default).

## Container

The image is multi-stage. Compilers and pnpm stay in the build stage; the
runtime stage holds Node, the production dependencies (with the mediasoup
worker binary) and the sources, owned by root. The SFU runs as the `node`
user (uid 1000), and only `/var/lib/conclave` is writable.
`docker-compose.sfu.yml` adds a read-only root filesystem with a `/tmp`
tmpfs, `no-new-privileges` and `cap_drop: ALL`. mediasoup binds only ports
above 1024, so it needs no capabilities.

Both services run with `NODE_ENV=production`, which makes the SFU refuse to
start with the default `SFU_SECRET` or without `SFU_CORS_ORIGINS` (compose
defaults it to `https://conclave.acmvit.in`; list every web origin that
uploads chat images or polls the socket). The deploy preflight checks both
before anything restarts. Logs default to `warn` in production; set
`SFU_LOG_LEVEL=info` in `.env` for join and room logs.

Containers built before this change ran as root, so the recordings volume
(and the SQLite database in it) is root-owned on existing hosts.
`scripts/deploy-sfu.sh` builds each instance, then runs a one-shot root
`find ... -exec chown node:node` on the volume before starting the new
container, and repeats it before the second instance restarts. A manual
`docker compose up` on such a host needs the same step first:

```sh
docker compose -f docker-compose.sfu.yml run --rm --no-deps --user root \
  --cap-add CHOWN --cap-add DAC_READ_SEARCH --entrypoint chown sfu-a -R node:node /var/lib/conclave/recordings
```

Both SFUs keep scheduled meetings, webinars and scheduling records in one
SQLite file on the recordings volume. If it will not open, a production SFU
exits at startup instead of falling back to a JSON copy that the other instance
would overwrite and SQLite would never import back. The container restart then
retries SQLite. Set `SCHEDULING_PERSISTENCE`, `SCHEDULED_MEETINGS_PERSISTENCE`
or `SCHEDULED_WEBINARS_PERSISTENCE` to `json` only for a single instance.

## To apply in production

Leave `SFU_WORKER_COUNT` unset on the 2-vCPU production VM to use the derived
count. Unset it in the deploy shell and remove it from `.env` and
`packages/sfu/.env`. Both `SFU_WORKER_COUNT=0` and blank assignments such as
`SFU_WORKER_COUNT=` fail preflight and startup.
Resize the VM before configuring a higher worker count, leaving headroom for
signaling and colocated services. Compose assumes two SFU instances share the
host. Set `SFU_WORKER_HOST_INSTANCES=3` on production when staging shares that VM.
The default divides the effective CPU affinity and quota limit by the instance
count, rounds down, and starts at least one worker. Outside Compose it assumes
one instance unless you supply the count.

Compose defaults `SFU_WEBRTC_PORT_BUDGET` to 4 per instance. The effective
budget `B` is the smaller of that setting and the size of the RTC range minus
four. The final four ports support separate RTP and RTCP for shared-browser
audio and video. Startup logs the selected count, warns when the budget caps
automatic sizing, and rejects an explicit worker count above the budget.
Startup and deploy preflight both require positive integers for any worker
count, host instance count, or WebRTC budget you set.

Before deploying, reserve the RTC ranges on the Linux host so outbound sockets
do not take WebRTC ports as ephemeral ports. Read existing reservations with
`sysctl net.ipv4.ip_local_reserved_ports`. Persist the production and staging
range in `/etc/sysctl.d/90-conclave-rtc-ports.conf`, or add it to the existing
persistent assignment. Keep any existing ranges in the same comma-separated
value. For a host without existing reservations, use:

```ini
net.ipv4.ip_local_reserved_ports=40000-42200
```

Apply with `sudo sysctl --system` and verify the effective list with
`sysctl net.ipv4.ip_local_reserved_ports`. Update the reservation if you change
the RTC ranges. [Linux IP sysctl reference](https://docs.kernel.org/networking/ip-sysctl.html)

Allow public UDP and TCP from `RTC_MIN_PORT` through `RTC_MIN_PORT + B - 1`.
Allow plain RTP over UDP from `RTC_MIN_PORT + B` through `RTC_MAX_PORT` from
authorized relay sources. With the default budget, use these ranges:

| Instance | Public UDP and TCP | Relay-source UDP |
| --- | --- | --- |
| `sfu-a` | 40000-40003 | 40004-41000 |
| `sfu-b` | 41001-41004 | 41005-42000 |
| Staging | 42001-42004 | 42005-42200 |

Resizing the VM can fill more slots within a budget. The maximum reachable
worker count and firewall split stay fixed unless the budget or RTC range
changes.

Keep the legacy UDP and TCP ranges open until calls on both old instances have
drained and both instances have restarted. Update the firewall before changing
the budget or RTC ranges. Outside Compose, if you omit the budget, plain RTP
starts after the actual worker ports.

## Development

```sh
pnpm -C packages/sfu exec tsc --noEmit   # typecheck
pnpm -C packages/sfu test                # vitest unit tests
pnpm run lint:packages                   # workspace lint (from repo root)
```

Untrusted network input (express `req.body`, socket payloads) is narrowed
once at the boundary via [`utilities/untrusted.ts`](./utilities/untrusted.ts)
— never accessed as `any`. Game move payloads have their own throwing
decoders in `server/games/validation.ts`.
