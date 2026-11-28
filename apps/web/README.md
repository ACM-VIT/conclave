# Conclave Web

Next.js web client, API routes, and Cloudflare Workers (`transcript-worker/` and `scheduling-email-worker/`).

## Commands

Run from the repo root (after `pnpm install`):

```bash
pnpm -C apps/web run dev                        # Next.js dev server (http://localhost:3000)
pnpm -C apps/web run build                      # production Next.js build
pnpm -C apps/web run lint                       # ESLint
pnpm -C apps/web run typecheck                  # next typegen + web + worker tsc checks
pnpm -C apps/web run test                       # unit tests + transcript caption oracle
pnpm -C apps/web run test:unit                  # unit tests only
```

Companion Workers:

```bash
pnpm -C apps/web run transcript:dev             # local transcript Durable Object Worker (:8788)
pnpm -C apps/web run transcript:typecheck
pnpm -C apps/web run scheduling-email:dev       # local scheduling email Worker (:8789)
pnpm -C apps/web run scheduling-email:typecheck
```

## Client Integration Notes

- `src/app/meets-client-page.tsx` wraps `MeetsClient` and supplies `getJoinInfo`, `getRooms`, `getRoom`, and `reactionAssets`. See [`src/app/README.md`](./src/app/README.md) for the prop contract.
- Reaction GIFs live in `public/reactions` and are passed as filenames via `reactionAssets`.
- Set `NEXT_PUBLIC_SFU_CLIENT_ID` to tag requests with `x-sfu-client` for per-client SFU policies.
- Under `next dev`, SFU requests default to `http://localhost:3031` unless `SFU_URL` or `NEXT_PUBLIC_SFU_URL` is set.
- Telemetry setup and PostHog ingestion live in [`src/app/lib/telemetry.md`](./src/app/lib/telemetry.md).

## Main Web Worker

### `@Conclave` Assistant

The in-chat `@Conclave` assistant runs through a Next.js route in the main Cloudflare Worker. Provider adapters, room AI keys, and gateway configuration are documented in [`packages/ai/README.md`](../../packages/ai/README.md).

| Variable | Notes |
| --- | --- |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Optional shared keys for the configured provider. Participants can also supply a session-only key in browser memory. |
| `CONCLAVE_ASSISTANT_MODEL` | Shared model override; defaults to `gpt-6.1-sol`. |
| `GITHUB_ISSUES_TOKEN` | Optional fine-grained GitHub token (Issues read/write on the target repo) for user-requested issue creation. |
| `GITHUB_ISSUES_REPOSITORY` | Target `owner/repo` for assistant issues; defaults to `ACM-VIT/conclave`. |

Set production secrets on the main Worker:

```bash
pnpm -C apps/web exec wrangler secret put OPENAI_API_KEY --config wrangler.jsonc
pnpm -C apps/web exec wrangler secret put GITHUB_ISSUES_TOKEN --config wrangler.jsonc
```

### Text-to-Speech and Voice Cloning

In Audio settings, participants can pick a browser system voice or (when signed in and after checking the consent box) create an instant ElevenLabs voice clone from a 10–20 second mic sample. `/tts <text>` carries an encrypted voice capability so neither the API key nor the raw provider voice ID reaches the browser. Web clients synthesize the cloned voice and fall back to a system voice if unavailable; native clients use their system TTS voice. Deleting a clone removes it from both ElevenLabs and browser local storage.

- `ELEVENLABS_API_KEY`: required to create, synthesize, and delete cloned voices.
- `TTS_VOICE_TOKEN_SECRET`: encrypts cloned-voice capabilities (use a dedicated high-entropy secret in production; falls back to `SFU_SECRET`).
- `ELEVENLABS_TTS_MODEL`: optional override; defaults to `eleven_multilingual_v2`.

### Chat Image Moderation

The SFU moderates every uploaded chat image through OpenAI's `omni-moderation-latest` model before creating a room attachment. Uploads fail closed if moderation is unconfigured, times out, errors, or flags the image. The call is asynchronous and does not block other chat or media traffic.

- `OPENAI_API_KEY`: required on the SFU (or contributed as a room key).
- `SFU_IMAGE_MODERATION_TIMEOUT_MS`: per-image timeout in ms; defaults to `8000` (clamped to 1–30 seconds).

## Security Headers

[`src/lib/security-headers.ts`](./src/lib/security-headers.ts) generates headers applied by `next.config.ts` to every page and API route on both `next start` and the OpenNext Worker. Static files served directly from Cloudflare assets skip the Worker and get HSTS, `nosniff`, and `Referrer-Policy` from [`public/_headers`](./public/_headers).

- **Framing:** blocked via `X-Frame-Options: DENY` and enforced `Content-Security-Policy: frame-ancestors 'none'` (`next dev` allows same-origin frames for dev bots).
- **Permissions-Policy:** allows camera, microphone, and screen capture for self only, plus fullscreen for YouTube embeds.
- **Shared browser frames:** pass the same `BROWSER_PUBLIC_BASE_URL` (or `BROWSER_HOST_ADDRESS` for direct noVNC ports) to the web build so `frame-src` allows the Chromium frame.
- **Report-only CSP:** full CSP is sent via `Content-Security-Policy-Report-Only`, posting to `/api/csp-report`. The route strips query strings, logs one `[csp-report] {...}` line per report, and limits calls to 30/min per client via `CSP_REPORT_RATE_LIMITER` (only Cloudflare's edge vouches for `cf-connecting-ip`; without a limiter in production the route answers `503`). When adding a new external origin, allowlist it in `src/lib/security-headers.ts`.

Moving CSP to enforcement: once Worker logs show zero real-page `[csp-report]` lines across two weeks including a release (ignoring browser extensions), rename the header to `Content-Security-Policy` (folding in `frame-ancestors`), keep `report-uri`, mirror the policy in `public/_headers`'s `/*` block, and monitor logs for a day. Removing `'unsafe-inline'` from `script-src` requires per-request nonces from `proxy.ts`, which turns `/privacy`, `/delete-account`, `/sfu-admin`, and the not-found page dynamic.

## Meeting Transcript Worker

Live captions, Q&A, and minutes run on a Cloudflare Durable Object Worker in `transcript-worker/`. The SFU issues a short-lived room token via `transcript:getToken`, and browsers connect directly to `GET /rooms/:roomId/ws?token=...`. Active controller keys stay in Durable Object memory for the live session, are never written to Durable Object storage, and are redacted from errors.

Required in production:

- `TRANSCRIPT_TOKEN_SECRET`: shared with the SFU to verify room tokens.
- `TRANSCRIPT_WORKER_URL`: SFU-facing URL (`https://transcribe.conclave.acmvit.in` in production; falls back to `NEXT_PUBLIC_TRANSCRIPT_WORKER_URL` locally).

Optional provider keys and settings:

- `OPENAI_API_KEY`, `SARVAM_API_KEY`, `ANTHROPIC_API_KEY`: cover room-wide transcription (`OpenAI`/`Sarvam`) and Ask/Minutes (`OpenAI`/`Anthropic`).
- `TRANSCRIPT_ALLOWED_ORIGIN`: optional WebSocket origin lock.
- `TRANSCRIPT_IDLE_TTL_MS`, `TRANSCRIPT_MAX_SEGMENTS`: idle Durable Object cleanup and segment cap.
- `TRANSCRIPT_TRANSCRIPTION_LANGUAGE` (`en`), `TRANSCRIPT_TRANSCRIPTION_LOCALE` (`en-IN`), `TRANSCRIPT_TRANSCRIPTION_PROMPT`: prompt-localization hints for names, acronyms, and Hinglish.
- `TRANSCRIPT_SARVAM_LANGUAGE_CODE` (`unknown`), `TRANSCRIPT_SARVAM_MODE` (`codemix`), `SARVAM_STT_WS_URL`: Sarvam Saaras v3 tuning.
- `CLOUDFLARE_AI_GATEWAY_OPENAI_URL` / `OPENAI_BASE_URL` / `OPENAI_REALTIME_URL`, `CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL` / `ANTHROPIC_BASE_URL`: provider endpoint overrides.

### Sarvam connections

Each speaker turn (audio between two flushes) gets its own Sarvam streaming WebSocket and never reuses a socket across turns, because Sarvam responses carry no utterance ID or stream position and `flush` has no acknowledgement. Rooms cap concurrent Sarvam sockets at 4 across active and draining sessions, hold steady background hum back for 60 seconds after 10 seconds of silent audio, and isolate socket failures to that turn. See [ADR 0029](../../docs/adr/0029-one-sarvam-socket-per-turn.md) for the exact state machine, timeouts, and trade-offs.

Deploy `conclave-transcript` (`https://transcribe.conclave.acmvit.in`):

```bash
pnpm -C apps/web exec wrangler deploy --config wrangler.transcript.jsonc --dry-run
pnpm -C apps/web run transcript:deploy
```

Verify before deploying: `pnpm -C apps/web run lint`, `pnpm -C apps/web run typecheck`, and `pnpm -C apps/web run test`.

## Scheduling Email Worker

Booking confirmations and reminders are rendered with React Email in `packages/sfu/server/email/` and sent through the Cloudflare Email Service Worker in `scheduling-email-worker/`. Google Calendar sync creates events with `sendUpdates=none`, leaving email delivery to this Worker.

Required in production:

- Verify `scheduling@conclave.acmvit.in` in Cloudflare Email Routing / Email Service.
- Set the Worker secret: `pnpm -C apps/web exec wrangler secret put SCHEDULING_EMAIL_WORKER_SECRET --config wrangler.scheduling-email.jsonc`.
- On the SFU, set `SCHEDULING_EMAIL_WORKER_URL=https://scheduling-email.conclave.acmvit.in` and the same `SCHEDULING_EMAIL_WORKER_SECRET`.

Optional SFU settings:

- `SCHEDULING_EMAIL_ENABLED=0` / `SCHEDULING_EMAIL_REMINDERS_ENABLED=0`: disable confirmations or reminders.
- `SCHEDULING_EMAIL_TIMEOUT_MS` (default `8000`), `SCHEDULING_EMAIL_REMINDER_MINUTES` (default `30`).
- Preview templates locally: `pnpm -C packages/sfu run email:dev`.

Deploy `conclave-scheduling-email` (`https://scheduling-email.conclave.acmvit.in`):

```bash
pnpm -C apps/web exec wrangler deploy --config wrangler.scheduling-email.jsonc --dry-run
pnpm -C apps/web run scheduling-email:deploy
```

Verify before deploying: `pnpm -C apps/web run scheduling-email:typecheck`, `pnpm -C packages/sfu run typecheck`, and `pnpm run typecheck`.
