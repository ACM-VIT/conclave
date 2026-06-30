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

## Meeting transcript worker

The meeting transcript dock uses a Cloudflare Durable Object worker in
`transcript-worker/`. The SFU issues a short-lived room token through the
`transcript:getToken` socket event, and browsers connect directly to:

`GET /rooms/:roomId/ws?token=...`

Required production configuration:
- `TRANSCRIPT_TOKEN_SECRET`: shared by the SFU and transcript worker for token verification.
- `TRANSCRIPT_WORKER_URL`: SFU-facing worker URL. Production uses `https://transcribe.conclave.acmvit.in`. `NEXT_PUBLIC_TRANSCRIPT_WORKER_URL` is accepted as a fallback for local environments.
- `OPENAI_API_KEY`: optional transcript worker secret for OpenAI transcription plus Ask/Minutes. When set, meeting participants see the OpenAI key field as `On the house`.
- `SARVAM_API_KEY`: optional transcript worker secret for Sarvam Saaras v3 transcription. Sarvam sessions still need `OPENAI_API_KEY` or a participant-supplied OpenAI assistant key for Ask/Minutes.
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
- `OPENAI_RESPONSES_URL`: override for the Responses API endpoint.

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
- Optional Cloudflare secrets for free room-wide transcript starts: `OPENAI_API_KEY`, `SARVAM_API_KEY`
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
