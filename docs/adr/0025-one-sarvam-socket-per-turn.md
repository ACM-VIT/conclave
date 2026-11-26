# 0025. Every Sarvam turn gets its own socket

- Status: Accepted
- Date: 2026-11-27

## Context

Live captions send each speaker's audio to Sarvam's streaming speech-to-text WebSocket and show the transcripts it sends back. Sarvam's answers carry no utterance id and no stream position, and its `flush` message has no acknowledgement ([WebSocket reference](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws), read 2026-11-25). On a socket that carries more than one turn, the only way to tell which turn an answer belongs to is to guess from timing.

The transcript worker guessed. It gave each speaker one socket and treated a turn as finished 2.5 s after its flush. The final review of PR #315 at `78bdb1111` showed what the guess cost:

- An answer that came later than 2.5 s landed on the speaker's next turn, out of order, or found its quiet caption already deleted.
- One socket closing, erroring or failing to open ended every speaker's captions and reopened every socket at once.
- The four-socket limit was counted per session, so a language switch held eight.

The owner's rule for captions is that speech is never shown under the wrong person or in the wrong place, and a visible gap is the accepted cost.

## Decision

A turn is one speaker's audio between two flushes. Every turn opens its own Sarvam socket, and that socket never carries another turn. Every answer on a socket belongs to its one turn.

- **Ending a turn.** The relay's clear, a pause, 3 s without audio, or 10 s of audio below our voice check flushes the turn. The speaker's next audio opens a new socket.
- **Hum.** Audio below our voice check is hum only when Sarvam signals no speech in 10 s of it either, counted from when that audio was sent. Hum is held back for a minute and then offered to Sarvam again. A 3 s pause, or audio our check hears, ends the hold at once. A soft-spoken speaker Sarvam signals within those 10 s is never held back.
- **Showing a caption.** The caption is final once Sarvam has answered every speech start in the turn, at least once. The socket stays open until 30 s after the flush, and a later part is added to the same caption. A turn still owed an answer at 30 s keeps its words and adds the gap marker, or ends as a gap when our voice check heard speech and Sarvam sent no words. A session that closes first (a language switch, a failed session) does the same for every caption that shows words and is still owed an answer, and a draining session stays open while one is.
- **One failure, one turn.** A socket that drops, errors, fails to open or stops taking audio ends only its own turn. A turn with no words yet is replayed once on a new socket. A speaker whose socket failed before Sarvam sent anything on it waits 0.5 s, doubling to 8 s, before the next one opens. Only a rejected key, a bad request, or a provider error before Sarvam has sent anything fails the session.
- **One budget per room.** The room holds at most four Sarvam sockets, counted in one place (`SocketBudget`) across the live session, a session still draining after a language switch, and sockets still opening. A full room closes the oldest socket whose turn is fully answered. A socket still owed an answer is never closed early.

## Consequences

- A late answer can only reach its own turn. Wrong speaker and wrong turn are ruled out by which socket the answer arrived on, with no timing rule left to tune.
- Each turn pays for a socket open before its audio is sent. The audio waits in the room's 8 MiB store until the socket is open.
- A busy room opens a socket per turn. Sarvam's limiter reacts to how fast connections open and rejects with close code 1003. The per-speaker wait covers that case, and it has not been measured against the real service. Measure it on staging before production.
- A late part that arrives after a full room closed its socket is lost without a gap marker, because the turn had already been answered once.
- Sarvam can answer one utterance of a turn with an empty transcript while it answers the rest with words. The caption shows the words and no gap marker, because nothing says which utterance was empty.
- A soft-spoken speaker can go uncaptioned for up to a minute when Sarvam signals nothing in 10 s of their audio: whispering over steady hum, or a speech signal that arrives late. The count restarts on a new session, so it can also happen right after a language switch.
- Revisit if Sarvam adds a flush acknowledgement or a per-utterance id, or if staging shows the open rate tripping the limiter.

## Alternatives considered

- **Keep one socket per speaker and wait longer than 2.5 s:** rejected. Any fixed wait is still a guess. A longer wait delays every caption and still misplaces an answer slower than the wait.
- **Reuse the speaker's socket once the previous turn is answered:** rejected. Sarvam can split one turn into several answers, so one answer does not show the turn is finished.
- **Sarvam's realtime API (`saaras:v4`), which numbers utterances per session:** not chosen in this change. Its flush has no acknowledgement either, and the docs do not say whether a flushed utterance gets its own number. It is the first thing to try if the open rate becomes a problem.

## Code

- `apps/web/transcript-worker/src/transcription/sarvam.ts`: `SarvamTurn`, `SarvamTranscriptionSession`, `LaneSocket`
- `apps/web/transcript-worker/src/transcription/socket-budget.ts`: `SocketBudget`
- `apps/web/transcript-worker/src/room.ts`: `sendChunk`, `loseLine`, `endOverdueLines`, `replayToLane`, `settleDrain`, `detachConnection`
- `apps/web/test/transcript-caption-violations.test.ts`: one row per finding
- `apps/web/test/transcript-caption-oracle.test.ts`: the seeded check, including one turn per socket on the wire, the room-wide socket count, how long held audio may wait, and that audio is held back only as hum
- `apps/web/README.md`: "Sarvam connections"
