# Architecture decision records

An ADR records one decision the code cannot express: why the code is shaped this way, what we rejected, or an outside constraint (a protocol, browser, vendor or platform rule) the code has to obey. A careful new maintainer who has not read it would get the code wrong.

Conclave keeps no code comments. `conclave/no-comments` and the comment ratchet (`scripts/quality/comments/`) block new ones, so these records are where the reasons live.

## When to write one

Write an ADR when:

- you would otherwise need a comment to stop someone undoing a choice;
- a constraint comes from outside our code, such as a mediasoup, WebRTC, Safari, Android or App Store rule;
- you rejected an alternative that looks obviously better;
- a comment audit classifies a comment as a decision record.

Do not write one for:

- what the code already says through names, types or tests;
- a temporary hack. File an issue with the `comment-excuse` label instead, and fix the hack.

## Numbering and files

- Files are `NNNN-kebab-case-title.md`, numbered from `0001` in the order they are written. `0000-template.md` is the template.
- Numbers are never reused or changed. A replaced decision keeps its file, sets its status to `Superseded by NNNN`, and links to the new record.
- Status is one of `Proposed`, `Accepted`, `Superseded by NNNN` or `Deprecated`.
- One decision per file. Merge related comments into one record by topic, not one record per comment.

## Template

Copy [`0000-template.md`](0000-template.md). It is MADR-lite:

- **Context:** the forces and constraints, with links to specs, bugs or measurements.
- **Decision:** what we do, stated plainly.
- **Consequences:** what gets easier, what gets harder, and what would make us revisit it.
- **Alternatives considered:** each one with the reason we rejected it.
- **Code:** the files and symbols that carry the decision.

## Replacing comments

A comment stops working the moment the code next to it changes. A record works when someone can reach it from the code and reach the code from it.

From the code, without a comment:

- Name the decision in an identifier, such as `ONE_FRAMERATE_PER_SIMULCAST_PROFILE` or `resumeConsumerWithAckRetry`, so the name states the rule.
- Put the decision in a test named after it, such as `test("ADR 0003: an attendee never receives panelist audio tracks", ...)`. The test enforces the decision and `git grep "ADR 0003"` finds it.
- Prefer a type that makes the wrong state unrepresentable over a sentence that warns against it.

From the record, list every file and symbol in its **Code** section and in the index below. Then each of these finds the record:

```sh
grep -rn "packages/sfu/server/rooms.ts" docs/adr
grep -rn "resumeConsumerWithAckRetry" docs/adr
```

When you rename a symbol or move a file named in a record, update the record in the same change.

## Index

Keep this table sorted by number. Code lists the paths and symbols, so a search by file or symbol lands here.

| ADR | Title | Status | Code |
| --- | --- | --- | --- |
| [0001](0001-workspace-lint-is-a-set-of-bug-catching-rules.md) | Workspace lint is a set of bug-catching rules | Accepted | `eslint.config.mjs`: `baseRules`, `typedRules`; `packages/sfu/utilities/untrusted.ts`: `asRecord`, `readString`, `readCoercedNumber` |
| [0002](0002-a-client-host-claim-never-grants-host.md) | A client host claim never grants host | Accepted | `packages/meeting-core/src/host-grant.ts`: `resolveHostGrant`, `HostGrantInput`; `packages/meeting-core/test/host-grant.test.ts` |
| [0003](0003-ai-credentials-stay-on-trusted-servers.md) | AI credentials stay on trusted servers | Accepted | `packages/ai/src/room-server.ts`: `roomAiEnvironment`, `fetchRoomAiEnvironment`, `describeRoomAiLookupFailure`; `packages/ai/src/catalog-server.ts`: model discovery fetches; `packages/ai/src/errors.ts`: `describeAiError`; `packages/sfu/server/roomAiSettings.ts`: `roomAiFeatureDefaults`; `packages/sfu/server/roomAiCredentials.ts`: `RoomAiCredentials` |
| [0004](0004-ai-model-discovery-and-provider-adaptation.md) | AI model discovery admits known families and adapts provider output | Accepted | `packages/ai/src/models.ts`: `responseModelProfile`; `packages/ai/src/catalog-server.ts`; `packages/ai/src/providers/anthropic.ts`: `anthropicSchema`, structured output with web search; `packages/ai/src/providers/openai.ts`: Responses input replay |
| [0005](0005-typescript-sources-drive-generated-native-code.md) | TypeScript sources drive generated native code | Accepted | `packages/meeting-core/scripts/gen-swift-events.mjs`; `packages/ui-tokens/scripts/gen-native-tokens.mjs`: `renderNativeTokens`; `scripts/gen-native-emoji-shortcodes.mjs`; `package.json`: `check:swift-events`, `check:native-tokens`, `check:native-emoji` |
| [0006](0006-one-flat-design-token-source.md) | One flat design token source, with platform semantics in native adapters | Accepted | `packages/ui-tokens/src/tokens.ts`: `color`, `space`, `font`, `motion`, `native`; `packages/ui-tokens/src/tokens.css`; `packages/ui-tokens/scripts/gen-native-tokens.mjs`: `renderNativeTokens` |
| [0007](0007-one-script-owns-native-icon-and-brand-assets.md) | One script owns the native icon and brand assets | Accepted | `packages/ui-tokens/scripts/gen-native-icons.py`: `DRAWABLES`, `APP_ICON`, `ADDITIVE_24PX`, `WHITE`, `GENERATED_MARK`; `packages/ui-tokens/scripts/gen-native-icons.test.py`; `scripts/quality/comments/policy.mjs`: `isProvenanceHash` |
| [0008](0008-portrait-video-framing-in-grid-tiles.md) | Portrait video framing in grid tiles | Accepted | `apps/web/src/app/lib/tile-video-framing.ts`: `PORTRAIT_VISIBLE_HEIGHT`, `PORTRAIT_ASPECTS`, `LANDSCAPE_ASPECTS`, `PORTRAIT_BACKDROP_STYLE` |
| [0009](0009-mediapipe-telemetry-is-patched-out.md) | MediaPipe telemetry is patched out of the vendored bundle | Accepted | `scripts/check-mediapipe-privacy.mjs`; `package.json`: `check:mediapipe-privacy` |
| [0010](0010-the-web-worker-build-inlines-nextjs-manifests.md) | The web Worker build inlines every Next.js manifest | Accepted | `scripts/cloudflare-manifests.test.mjs`; `package.json`: `test:cloudflare-manifests` |
| [0011](0011-video-quality-harness-measures-against-browser-behavior.md) | The video quality harness measures against real browser behavior and calibrated floors | Accepted | `scripts/quality/browser-fixture.mjs`: `handleVideoFrame`; `scripts/quality/media-latency.mjs`: `summarizeCaptureToDisplayLatency`; `scripts/quality/rtc-summary.mjs`; `scripts/quality/dynamic-network-transition.mjs`: `selectedCandidatePairIsUsable`; `scripts/quality/dynamic-network-runner.mjs`: `sleepUntil`; `scripts/quality/run-headless-video-quality.mjs`; `scripts/quality/profiles.mjs`; `scripts/quality/scoring.mjs`: `linearScore`, `qualityDensityTarget`, `latencyScorePenalty`; `scripts/quality/visual-metrics.mjs`: `createVisualMetricToolkit` |
| [0012](0012-sfu-deployment-compatibility-and-tenant-boundaries.md) | SFU deployment compatibility and tenant boundaries | Accepted | `packages/sfu/server/clientIds.ts`: `canMigrateClientNamespace`; `packages/sfu/server/cors.ts`: `resolveCorsOrigins`; `packages/sfu/server/inviteCodeVersion.ts`: `newInviteCodeVersion`; `packages/sfu/utilities/untrusted.ts`: `readCoercedNumber`, `readCoercedBoolean`; `packages/sfu/server/browserServiceClient.ts`: capabilities fallback |
| [0013](0013-operator-access-and-room-moderation.md) | Operator access and room moderation | Accepted | `packages/sfu/server/socket/handlers/adminHandlers.ts`: `canSeeOtherRooms`, `adminHandlersRegistered`, `ensureAdminRoom`; `packages/sfu/server/admin/moderation.ts`: `isSuperAdminClient`; `packages/sfu/server/admin/adminAudit.ts`: `recordAdminAudit` |
| [0014](0014-scheduled-webinar-link-codes-belong-to-their-room.md) | Scheduled webinar link codes belong to their room | Accepted | `packages/sfu/server/socket/handlers/webinarHandlers.ts`: link code update, `getScheduledWebinarBySlug` |
| [0015](0015-webcam-codec-and-upload-capacity-policy.md) | Webcam codec and upload capacity policy | Accepted | `packages/sfu/server/webcamCodecPolicy.ts`: `selectRoomWebcamCodec`, `participantsSupportWebcamCodec`, `buildWebcamCodecPolicy`; `packages/sfu/config/classes/Client.ts`: `updateMediaCapabilities`; `packages/sfu/server/producerTransportNetworkProfile.ts`: `PRODUCER_TRANSPORT_EMERGENCY_MAX_INCOMING_BITRATE_BPS`, `getProducerTransportMaxIncomingBitrate`; `apps/web/src/app/lib/microphone-send-estimate.ts`: `stepMicrophoneSendEstimate` |
| [0016](0016-consumer-handoff-transport-connect-and-keyframes.md) | Consumer handoff, transport connect and keyframe recovery | Accepted | `packages/sfu/config/classes/Client.ts`: `reserveConsumerHandoff`, `abortConsumerHandoff`, `MAX_CONSUMER_HANDOFF_RECORDS`, `MAX_LIVE_CONSUMER_GENERATIONS`; `packages/sfu/server/socket/transportConnect.ts`: `connectWebRtcTransportOnce`; `packages/sfu/test/transport-connect.test.ts`; `packages/sfu/server/mediaPolicy.ts`: `WEBCAM_KEY_FRAME_REQUEST_DELAY_MS`, `SCREEN_KEY_FRAME_REQUEST_DELAY_MS`, `shouldExplicitlyRequestConsumerKeyFrame` |
| [0017](0017-chat-and-assistant-relay-wire-contracts.md) | Chat and assistant relay wire contracts | Accepted | `packages/sfu/server/socket/handlers/chatHandlers.ts`: `normalizeReplyTo`, `normalizeChatGifAttachment`, `normalizeConclaveTasks`, `normalizeConclaveAnswer`, `registerChatHandlers` |
| [0018](0018-server-authoritative-game-sessions.md) | Server-authoritative game sessions and projections | Accepted | `packages/sfu/server/games/types.ts`: `GameModule`, `GameMoveError`, `spectatable`, `lateJoinPhases`, `selfId`, `showWhen`; `packages/sfu/server/games/engine.ts`: `GameSession`, `seatPendingIfBoundary`; `packages/sfu/server/games/roundLoop.ts`: `allActivePlayersActed`, `createRoundLoop`; `packages/sfu/server/games/rng.ts`: `createSeed`, `createRng`; `packages/sfu/server/games/modules/reaction.ts`; `packages/sfu/server/games/modules/imposter.ts`; `packages/sfu/server/games/modules/wordle.ts`: `playerView`; `packages/sfu/server/socket/handlers/gameHandlers.ts`: `broadcastGame` |
| [0019](0019-game-analytics-are-server-observed-and-pseudonymous.md) | Game analytics are server-observed and pseudonymous | Accepted | `packages/sfu/server/socket/handlers/gameHandlers.ts`: `TEXT_TOPIC_OPTION_ID`, `stableDistinctId`, `maybeCaptureGameFinished`, `playAnalyticsBySession`; `packages/sfu/server/analytics/posthog.ts` |
| [0020](0020-chess-bot-endgame-search.md) | Chess bot endgame search | Accepted | `packages/sfu/server/games/chessBot.ts`: `evaluate`, `pickBotMove`; `packages/sfu/scripts/bot-strength.ts` |
| [0021](0021-scheduling-email-uses-a-light-layout.md) | Scheduling email uses a light layout | Accepted | `packages/sfu/server/email/schedulingTemplates.tsx` |
