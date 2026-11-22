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

Keep `SFU_WORKER_COUNT=0` on the 2-vCPU production VM to use the derived count.
Resize the VM before configuring a higher worker count, leaving headroom for
signaling and colocated services. Compose assumes two SFU instances share the
host. Set `SFU_WORKER_HOST_INSTANCES=3` on production when staging shares that VM.
The default divides the effective CPU affinity and quota limit by the instance
count, rounds down, and reserves one worker at minimum. Outside Compose, it
assumes one instance unless you supply the count. Startup logs the worker count.

For an instance with `N` workers, allow inbound UDP and TCP from `RTC_MIN_PORT`
through `RTC_MIN_PORT + N - 1`. With one worker per instance, the production
defaults are 40000 for `sfu-a` and 41001 for `sfu-b`. Keep the legacy UDP and TCP
ranges open until calls on both old instances have drained and both instances
have restarted. Check the logged count before narrowing firewall rules.

Shared browser relays need plain RTP over UDP from `RTC_MIN_PORT + N` through
`RTC_MAX_PORT`. With one worker per instance, the production defaults are
40001 through 41000 and 41002 through 42000. Preserve access from the relay
sources. Update the firewall when changing worker counts or RTC ranges.

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
