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

Provision at least 8 vCPUs for the VM that runs both SFU instances. Compose pins
four media workers per instance to keep the UDP and TCP firewall ranges
predictable. Leave CPU headroom for signaling and other services on the VM.

Before deploying shared WebRTC sockets, allow inbound UDP and TCP to the SFU VM
on ports 40000 through 40003 for `sfu-a` and 41001 through 41004 for `sfu-b`.
Each of the four workers binds one port for both protocols, starting at the
instance's `RTC_MIN_PORT`. Plain RTP starts after the last worker port. Keep
the legacy UDP and TCP ranges open until calls
on both old instances have drained and both instances have restarted.

After the rollout, the public WebRTC rules need only those ports. Shared browser
relays still need plain RTP over UDP on 40004 through 41000 and 41005 through
42000. Preserve access from the relay sources for those ranges. Update the
firewall when changing `SFU_WORKER_COUNT` or the instance's RTC port range.

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
