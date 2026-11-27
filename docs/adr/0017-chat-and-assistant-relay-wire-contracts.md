# 0017. Chat and assistant relay wire contracts

- Status: Accepted
- Date: 2026-11-22

## Context

The SFU relays chat, GIF and image attachments, replies, `/tts` messages and the streamed `@Conclave` assistant answer to everyone in the room. Clients of several versions are connected at once, and none of them can be trusted to describe someone else's words.

## Decision

- **Quotes:** public reply previews are resolved from the SFU's broadcast history, so a reply cannot put fabricated words in someone else's mouth. Direct messages are never kept in public history, so a client-supplied quote snapshot is accepted only for a reply in the same private thread.
- **Klipy clips:** a clip may carry an MP4 `videoUrl` next to the GIF fallback in `url`. Only clips may declare one, and it must live on the same trusted Klipy media host as the image.
- **Image uploads:** the socket path does not gate on a safety model. The upload endpoint runs the image safety check when one is configured and accepts the image when none is.
- **TTS:** `/tts` is detected with any whitespace after the command, the same rule as the meeting-core parser, so tab-separated messages cannot bypass the host's TTS toggle or length cap.
- **Assistant relay:** the web app signs every streamed assistant packet it generates from an SFU-issued token. The SFU fans out only packets that match the current room and client and verify untampered. Optional process-state fields that are absent stay `undefined`, which `JSON.stringify` drops, so legacy packets keep the exact signing input they were signed with. The serialization must match the web assistant API route. Task lists are validated without rewriting any value, and a malformed list drops the whole packet.

## Consequences

- The SFU must be deployed before a web change that alters the signed packet shape.
- A legacy client's reply to a DM still works, but its public quote text is always the server's.

## Alternatives considered

- **Trusting client quote text:** rejected because anyone could misquote anyone.
- **Normalizing relayed assistant fields:** rejected because any change breaks the signature.

## Code

- `packages/sfu/server/socket/handlers/chatHandlers.ts`: `normalizeReplyTo`, `normalizeChatGifAttachment`, `normalizeConclaveTasks`, `normalizeConclaveAnswer`, `registerChatHandlers`
