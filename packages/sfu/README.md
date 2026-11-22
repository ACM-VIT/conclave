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

## To apply in production

Leave `SFU_WORKER_COUNT` unset on the 2-vCPU production VM to use the derived
count. Remove any existing `SFU_WORKER_COUNT=0` assignment before deploying.
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
authorized relay sources. With the default budget, public WebRTC uses 40000
through 40003 for `sfu-a` and 41001 through 41004 for `sfu-b`. The relay ranges
are 40004 through 41000 and 41005 through 42000. Resizing the VM can fill more
slots within a budget. The maximum reachable worker count and the firewall
split stay fixed unless the budget or RTC range changes.

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
