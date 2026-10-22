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
No live provider requests were made for this screenshot.

![Claude provider controls](docs/provider-controls.png)
