# Conclave Web

Development
- Install deps: `pnpm install`
- Start dev server: `pnpm -C apps/web run dev`
- Start transcript worker locally: `pnpm -C apps/web run transcript:dev`
- Run transcript worker typecheck: `pnpm -C apps/web run transcript:typecheck`
- Start scheduling email worker locally: `pnpm -C apps/web run scheduling-email:dev`
- Run scheduling email worker typecheck: `pnpm -C apps/web run scheduling-email:typecheck`
- Run web unit tests: `pnpm -C apps/web run test:unit`

Integration notes
- Provide `getJoinInfo` in `src/app/meets-client-page.tsx` (client wrapper) or wire your own wrapper.
- Optionally provide `getRooms` and `getRoomsForRedirect` to populate host room lists.
- Reaction assets are served from `public/reactions` and passed via `reactionAssets`.
- Set `NEXT_PUBLIC_SFU_CLIENT_ID` to tag requests with `x-sfu-client` so the SFU can apply per-client policies.

## Security headers

`src/lib/security-headers.ts` builds the headers that `next.config.ts` applies to
every page and API route. Both `next start` and the OpenNext worker serve them.
Files served straight from the Cloudflare assets binding skip the worker, so
`public/_headers` gives them HSTS, `nosniff` and `Referrer-Policy`.

- Framing is blocked by `X-Frame-Options: DENY` and an enforced
  `Content-Security-Policy: frame-ancestors 'none'`. `next dev` allows
  same-origin frames instead, for the dev bots panel's inline participants.
- `Permissions-Policy` allows camera, microphone and screen capture for this
  origin only. Fullscreen also extends to the YouTube embeds.
- The full Content Security Policy is sent as `Content-Security-Policy-Report-Only`.
  Browsers post violations to `/api/csp-report` (`report-uri`). The route logs
  one `[csp-report] {...}` line per report with query strings removed, and the
  `CSP_REPORT_RATE_LIMITER` binding caps it at 30 reports per minute per client.
  Only Cloudflare's edge vouches for `cf-connecting-ip`, so under `next start`
  or `next dev` every caller shares one bucket, and a production server with no
  limiter at all answers 503.

A self-hosted Chromium shared browser is framed from the browser service's
URL. Give the web build the same `BROWSER_PUBLIC_BASE_URL` as the service (or
`BROWSER_HOST_ADDRESS` when it links noVNC ports directly) so `frame-src`
allows it.

The allowlist comes from local runs, in development and production builds, of
a two-client call, a YouTube link embed and playback, the GIF picker, background
blur, an image background and a face filter, noise cancellation and the mic
test, Watch together, PostHog, sign-in and the static pages. Those runs
produced no violations. When a feature loads from a new origin, add the origin
in `security-headers.ts`.

**Switching to enforcement.** Enforce once the worker logs show no
`[csp-report]` lines from real pages for two weeks that include a release.
Ignore reports whose source is a browser extension. Then rename the
report-only header to `Content-Security-Policy` (folding in `frame-ancestors`),
keep `report-uri`, add the same policy to the `/*` block of `public/_headers`
so worker scripts are covered, and watch the reports for a day after deploy.
Removing `'unsafe-inline'` from `script-src` needs per-request nonces from
`proxy.ts`. Most routes already render dynamically. Only `/privacy`,
`/delete-account`, `/sfu-admin` and the not-found page are static and would
become dynamic.

## Chat image moderation

The SFU sends every uploaded chat image to OpenAI's
`omni-moderation-latest` model before creating the room-scoped attachment. The
check uses the server-side `OPENAI_API_KEY`; clients never receive the key and
cannot bypass the upload gate. Uploads fail closed if moderation is not
configured, times out, returns an invalid response, or flags the image.

- `OPENAI_API_KEY`: required on the SFU for chat image uploads.
- `SFU_IMAGE_MODERATION_TIMEOUT_MS`: optional per-image timeout; defaults to
  `8000` and is constrained to 1–30 seconds.

The provider request is asynchronous and gates only that image's upload
response. Other chat, media, and meeting traffic continues while it runs.

## Main web worker

The in-chat `@Conclave` assistant runs through the Next.js app route in the
main web Worker.

- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`: optional shared keys for the selected
  assistant provider. `CONCLAVE_ASSISTANT_MODEL` selects the shared model and
  defaults to `gpt-5.6-terra`. Participants can select an OpenAI or Claude model
  with their own matching key, kept in browser memory for the page session.
- Provider setup, model updates, and gateway settings live in
  [`packages/ai`](../../packages/ai/README.md).
- `GITHUB_ISSUES_TOKEN`: optional server-side fine-grained GitHub token that lets
  `@Conclave` create issues when a participant explicitly requests one. Grant it
  Issues read/write access only for the target repository.
- `GITHUB_ISSUES_REPOSITORY`: optional `owner/repository` target for assistant
  issues. Defaults to `ACM-VIT/conclave`.
- Set the production secret with `pnpm -C apps/web exec wrangler secret put OPENAI_API_KEY --config wrangler.jsonc`.
- Enable issue creation in production with `pnpm -C apps/web exec wrangler secret put GITHUB_ISSUES_TOKEN --config wrangler.jsonc`.

### Configurable text-to-speech and voice cloning

The Audio settings panel lets participants choose a browser system voice and,
when signed in, create an explicitly consented instant voice clone from a
10–20 second microphone sample. `/tts <text>` messages carry an encrypted voice
capability; the provider API key and raw provider voice ID are never exposed to
the browser. Web clients synthesize the cloned voice and fall back to their
selected system voice when cloning is unavailable. Native clients remain
compatible and currently use their system TTS voice.

- `ELEVENLABS_API_KEY`: required to create, synthesize, and delete cloned voices.
- `TTS_VOICE_TOKEN_SECRET`: encrypts cloned-voice capabilities. Use a dedicated,
  high-entropy production secret. `SFU_SECRET` is accepted as a fallback.
- `ELEVENLABS_TTS_MODEL`: optional model override; defaults to
  `eleven_multilingual_v2`.
- Voice samples are sent to ElevenLabs only after the owner checks the consent
  box. Clone metadata is stored in that browser's local storage; deleting the
  clone removes it from ElevenLabs and the browser.

## Meeting transcript worker

The meeting transcript dock uses a Cloudflare Durable Object worker in
`transcript-worker/`. The SFU issues a short-lived room token through the
`transcript:getToken` socket event, and browsers connect directly to:

`GET /rooms/:roomId/ws?token=...`

Required production configuration:
- `TRANSCRIPT_TOKEN_SECRET`: shared by the SFU and transcript worker for token verification.
- `TRANSCRIPT_WORKER_URL`: SFU-facing worker URL. Production uses `https://transcribe.conclave.acmvit.in`. `NEXT_PUBLIC_TRANSCRIPT_WORKER_URL` is accepted as a fallback for local environments.
- `OPENAI_API_KEY`: optional transcript worker secret for OpenAI transcription plus Ask/Minutes. When set, meeting participants see the OpenAI key field as `On the house`.
- `SARVAM_API_KEY`: optional transcript worker secret for Sarvam Saaras v3 transcription. When set, meeting participants see the Sarvam key field as covered by Conclave. Ask/Minutes use the selected assistant provider and require its shared or participant-supplied key.
- `ANTHROPIC_API_KEY`: optional transcript worker secret covering Claude Ask/Minutes models. Audio transcription still requires OpenAI or Sarvam.
- `TRANSCRIPT_ALLOWED_ORIGIN`: optional worker CORS/origin lock for browser WebSocket upgrades.

Optional worker configuration:
- `TRANSCRIPT_IDLE_TTL_MS`: idle Durable Object cleanup window, defaulted in `wrangler.transcript.jsonc`.
- `TRANSCRIPT_MAX_SEGMENTS`: maximum active-session transcript segments kept before trimming.
- `TRANSCRIPT_TRANSCRIPTION_LANGUAGE`: transcription language hint, defaults to `en`.
- `TRANSCRIPT_TRANSCRIPTION_LOCALE`: prompt-localization locale, defaults to `en-IN`.
- `TRANSCRIPT_TRANSCRIPTION_PROMPT`: extra prompt-localization terms for prompt-capable transcription models. Use this for team names, Indian names, Hinglish words, acronyms, and domain-specific vocabulary.
- `TRANSCRIPT_SARVAM_LANGUAGE_CODE`: Sarvam language-code hint. Defaults to `unknown` so Saaras v3 can auto-detect Indian languages.
- `TRANSCRIPT_SARVAM_MODE`: Sarvam Saaras v3 output mode. Defaults to `codemix` for Hinglish/code-mixed meetings.
- `SARVAM_STT_WS_URL`: override for the Sarvam speech-to-text WebSocket endpoint.
- `CLOUDFLARE_AI_GATEWAY_OPENAI_URL`: OpenAI-compatible AI Gateway URL for responses/minutes.
- `OPENAI_BASE_URL`: fallback OpenAI-compatible Responses API base URL.
- `OPENAI_REALTIME_URL`: override for the OpenAI Realtime WebSocket endpoint.
- `CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL` / `ANTHROPIC_BASE_URL`: Anthropic API base URL for Claude Ask/Minutes.

Sarvam connections:
- Every turn (one speaker's audio between two flushes) gets its own Sarvam streaming WebSocket, and that socket never carries another turn. Sarvam's flush has no acknowledgement and its answers carry no stream position ([WebSocket reference](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws)), so this is the only way to know which turn an answer belongs to: every answer on a socket belongs to its one turn.
- A turn's caption is final once Sarvam has answered every speech start in it, at least once. A speech start counts only after an end of speech or an answer, so a repeated start for one utterance never holds the caption. After that the socket stays open until 30 s after the flush, and a late second part is added to the same caption. A language switch keeps the old session open while a caption that already shows words is still owed an answer. A turn still missing an answer at 30 s keeps its words and adds the gap marker, or ends as a gap when our check heard speech and Sarvam sent none. A heard turn whose only answer is empty also ends as a gap.
- A socket that drops, errors or stops taking audio ends only its own turn. A turn with no words yet is replayed once on a new socket; a turn with words keeps them and adds the gap marker. A speaker whose socket failed before Sarvam sent anything on it (a failed open, or a socket closed straight after it opened) waits before the next one opens: 0.5 s, doubling to 8 s, and back to no wait once Sarvam sends anything for that speaker. A socket still opening when its turn or its session ends is cancelled. A rejected key or bad request (any non-retryable status, such as 400, 401 or 403) and a provider error before Sarvam has sent anything fail the session instead.
- A room holds at most 4 Sarvam sockets, counted across the live session, a draining session after a language switch, and the socket opened at connect time. Sarvam allows 20 concurrent streaming sockets per account on pay-as-you-go and 100 on Pro and Growth ([rate limits](https://docs.sarvam.ai/api-reference-docs/ratelimits)), shared by every room. When the room is full, the oldest socket whose turn is fully answered (or never had speech) is closed for the new turn; a socket still owed an answer is never closed early. Otherwise the new audio waits, within the shared 8 MiB audio limit, and a new session after a switch waits for the old session's sockets to free up. Audio never goes to another speaker's socket.
- The socket opened at connect time closes after 30 s if nobody speaks. A turn whose audio stops for 3 s ends even if the relay never ended it, and the speaker's next audio opens a new socket. Quiet audio (below our voice check) that lasts 10 s ends the speaker's turn, so it never holds a socket. If Sarvam signalled speech in it, the speaker is soft-spoken and their next audio opens a new turn. If Sarvam signalled nothing in 10 s of it either, it is hum: it is held back for a minute and then offered to Sarvam again. A 3 s pause, or audio our check hears, ends the hold at once. The 10 s count only audio that was really sent, so audio that waited for a socket is never judged early.
- Each turn opens a socket, so a busy room opens a few sockets a minute. Sarvam's limiter reacts to how fast connections open and rejects with close code 1003, which counts as a socket that failed before Sarvam sent anything, so that speaker waits before the next one opens.

The active controller's provider keys are sent to the worker only for the live
session. They stay in Durable Object memory, are not persisted to Durable Object
storage, and are redacted from worker errors before responses are sent.

Deployment and verification:
- Production Worker name: `conclave-transcript`
- Production Worker domain: `https://transcribe.conclave.acmvit.in`
- Dry-run deploy: `pnpm -C apps/web exec wrangler deploy --config wrangler.transcript.jsonc --dry-run`
- Deploy: `pnpm -C apps/web run transcript:deploy`
- Required gates: `pnpm -C apps/web run lint`, `pnpm -C apps/web exec tsc --noEmit`, `pnpm -C apps/web run transcript:typecheck`, and `pnpm -C apps/web run test:unit`.

Cloudflare main-branch linking:
- Config file: `apps/web/wrangler.transcript.jsonc`
- Build/deploy command: `pnpm -C apps/web run transcript:deploy`
- Required Cloudflare secret: `TRANSCRIPT_TOKEN_SECRET`
- Optional Cloudflare secrets for free room-wide transcript starts: `OPENAI_API_KEY`, `SARVAM_API_KEY`, `ANTHROPIC_API_KEY`
- Branch: `main`

## Scheduling email worker

Scheduling confirmations and reminders are rendered with React Email in
`packages/sfu/server/email/` and delivered through a Cloudflare Email Service
Worker in `scheduling-email-worker/`. The SFU calls the signed worker endpoint
after a booking is persisted and optional Google Calendar sync has completed.
Google Calendar event creation uses `sendUpdates=none`; the Worker owns attendee
and host email for all booking-link meetings.

Required production configuration:
- Cloudflare Email Routing/Email Service must verify `scheduling@conclave.acmvit.in`.
- Worker secret: `SCHEDULING_EMAIL_WORKER_SECRET`, set with `pnpm -C apps/web exec wrangler secret put SCHEDULING_EMAIL_WORKER_SECRET --config wrangler.scheduling-email.jsonc`.
- SFU env: `SCHEDULING_EMAIL_WORKER_URL=https://scheduling-email.conclave.acmvit.in`.
- SFU env: `SCHEDULING_EMAIL_WORKER_SECRET=<same secret as the Worker>`.

Optional SFU configuration:
- `SCHEDULING_EMAIL_ENABLED=0`: disables scheduling email delivery.
- `SCHEDULING_EMAIL_TIMEOUT_MS`: worker request timeout, default `8000`.
- `SCHEDULING_EMAIL_REMINDERS_ENABLED=0`: disables reminder email delivery.
- `SCHEDULING_EMAIL_REMINDER_MINUTES`: reminder lead time, default `30`.
- React Email preview: `pnpm -C packages/sfu run email:dev`.

Deployment and verification:
- Production Worker name: `conclave-scheduling-email`
- Production Worker domain: `https://scheduling-email.conclave.acmvit.in`
- Dry-run deploy: `pnpm -C apps/web exec wrangler deploy --config wrangler.scheduling-email.jsonc --dry-run`
- Deploy: `pnpm -C apps/web run scheduling-email:deploy`
- Required gates: `pnpm -C apps/web run scheduling-email:typecheck`, `pnpm -C packages/sfu run typecheck`, and `pnpm run typecheck`.
