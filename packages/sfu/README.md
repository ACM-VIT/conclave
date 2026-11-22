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
