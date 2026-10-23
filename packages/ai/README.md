# AI providers and models

`@conclave/ai/models` is the browser-safe registry for provider labels, key links,
credentials, model capabilities, output budgets, and feature defaults.
`@conclave/ai/server` owns SDK construction, gateway URLs, retries, text generation,
structured outputs, streaming events, and provider-native tool conversation replay.
Import the server entry only from server or Worker code.

The web assistant, transcript Q&A and minutes, and SFU game generation use this
package. Realtime voice, ElevenLabs voice cloning/TTS, and image moderation use the same
provider/default/endpoint registry;
moderation also uses the shared OpenAI client factory. The native Swift/Skip app retains its existing OpenAI assistant picker; these
text alternatives are exposed in the web client and server configuration.
Audio transcription remains
OpenAI or Sarvam: Claude is a text alternative, not a realtime audio provider.

## Configuration

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI text, transcription, and moderation credentials |
| `ANTHROPIC_API_KEY` | Claude text credentials |
| `SARVAM_API_KEY` | Sarvam transcription credentials |
| `ELEVENLABS_API_KEY` | ElevenLabs voice cloning and synthesis credentials |
| `CONCLAVE_ASSISTANT_MODEL` | Shared web chat model; defaults to `gpt-5.6-terra` |
| `SFU_GAME_AI_MODEL` | Game model; defaults to `gpt-5.6-luna` |
| `CLOUDFLARE_AI_GATEWAY_OPENAI_URL` / `OPENAI_BASE_URL` | OpenAI API base URL, gateway takes precedence |
| `CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL` / `ANTHROPIC_BASE_URL` | Anthropic API base URL, gateway takes precedence |

Model overrides must be registered response models; invalid deployment settings
fail instead of silently choosing another provider. The provider follows the model.
No request automatically fails over to another provider or credential. Explicit
participant credentials take precedence over shared credentials for chat. Transcript
sessions reuse their transcription key only when the response provider matches;
otherwise they need a separate assistant key or that provider's shared key.
Switching transcript Q&A to another provider requires restarting notes with its key.
Keys remain in live session memory and are never persisted in transcript storage.

Set secrets independently on the main web Worker, transcript Worker, and SFU that
need them. Set `ANTHROPIC_API_KEY` and `CONCLAVE_ASSISTANT_MODEL=claude-sonnet-5-5`
on the main web Worker to serve shared Claude chat. Transcript participants select
their assistant model in the notes panel. To use Claude for games, set
`ANTHROPIC_API_KEY` and `SFU_GAME_AI_MODEL=claude-haiku-5-5` on the SFU; both Compose
services forward these settings. Image moderation still requires the OpenAI key.

## Claude alternatives

Verified against the [Anthropic model catalog](https://platform.claude.com/docs/en/models/overview)
on October 22, 2026:

| Model ID | Use |
| --- | --- |
| `claude-haiku-5-5` | Fast summaries, simple questions, game content |
| `claude-sonnet-5-5` | Balanced meeting synthesis and tool use |
| `claude-opus-5-5` | More demanding synthesis and multi-step work |
| `claude-fable-5-1` | The most demanding reasoning workloads |

Claude keeps its native thinking defaults; OpenAI reasoning and verbosity settings
are not sent to Anthropic. The adapter emits activity events for Claude thinking
and preserves signed thinking internally for tool continuation. Raw thinking is
not displayed. Web search uses Anthropic's basic server search tool, with up to
five searches per request. Model availability and web search also depend on the
account's permissions.

Claude's [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
cannot share a response with citations. For structured game content with search
enabled, the adapter first gathers research, then makes a separate structured
request without search tools. This adds one request. Unsupported schema bounds
are carried in field descriptions; the existing minutes/game parsers still bound
and validate the results. Incomplete responses and provider errors fail the
request; games retain their existing local-content fallback.

## Room keys

The web chat and notes panels expose room AI settings. Active participants can add
OpenAI, Anthropic, or Sarvam keys for everyone in that room. Only the contributor
or a host can replace/remove a contribution. Keys live in the owning SFU room's
private memory and are cleared on room close; socket snapshots contain only
provider availability and ownership. A server restart requires adding them again.
Deployment keys take precedence over room contributions; explicit personal keys
remain scoped to the current assistant/notes session. Providers never share keys.

Room OpenAI keys cover image moderation and can also power text, games, and audio.
Moderation stays fail closed. The image button opens setup when a room lacks an
OpenAI key. Anthropic covers text; Sarvam covers audio. Games use the configured
`SFU_GAME_AI_MODEL`; setting `SFU_GAME_AI_ENABLED=false` still disables generation.

The web server and transcript Worker retrieve selected credentials through the
SFU's private `/internal/ai/credentials` endpoint. It requires a server shared
secret and exact active room/client/channel/user identity. Web uses `SFU_SECRET`;
Worker uses `TRANSCRIPT_TOKEN_SECRET` (or the shared SFU secret). Configure
`SFU_PUBLIC_URL` (or `SFU_INSTANCE_URL`) on the SFU for signed transcript routing, and the same
`TRANSCRIPT_TOKEN_SECRET` on SFU and Worker. No arbitrary browser URL is accepted.
The browser-safe `@conclave/ai/room` entry contains metadata only; credential
retrieval lives in `@conclave/ai/room-server`.

Removing a room key affects new requests. Active transcript sessions retain their
in-memory key until stopped; borrowed keys are never persisted for automatic
Worker recovery. Stop active notes to revoke their current key immediately.

All game generation stages, including Claude research plus structured output,
share one deadline capped at 35 seconds so completion fits the client's 45-second
start acknowledgement.

## Updating models

Edit `src/models.ts`, verify IDs and capabilities against provider documentation,
and update feature budgets/defaults there. Transcript and chat pickers consume the
same list. Keep the `meeting-core/transcript-models` re-export for existing clients.
Add a provider adapter behind `createAiTextSession` and `generateAiText` when
introducing a new text provider; product surfaces should not construct SDKs.

Run `pnpm check`. Provider tests use the real SDKs with fixture HTTP responses;
they do not spend provider credits or demonstrate live model availability.


## UI verification

Local fixture showing Claude selected in the existing notes and chat panels.
Desktop and narrow viewport checks used local fixtures; no live provider requests were made.

![Claude provider controls](docs/provider-controls.png)

![Room AI settings](docs/room-ai-settings.png)
