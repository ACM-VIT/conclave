# 0018. Server-authoritative game sessions and projections

- Status: Accepted
- Date: 2026-11-22

## Context

In-call party games (Trivia, Imposter, Wordle, Chess and others) carry hidden information and scores people care about. Unlike the collaborative apps runtime, where the SFU is a plain Yjs relay and every client sees the same state, a game cannot trust clients with the whole state or with the clock.

## Decision

- Canonical game state lives only on the SFU. Moves are validated on the server, and a module rejects an illegal move by throwing `GameMoveError`.
- `GameSession` is transport-agnostic. It applies moves, ticks and produces projections, and the handler layer decides delivery. Game modules are pure with respect to their state, and async work happens only in the content loader and move-preparation hooks.
- Each client receives projections: `publicView` is broadcast to the room, and `playerView` is emitted privately to one player's own socket. That private emit is the hidden-information boundary, so a player only ever receives their own view.
- Spectators (room members without a seat) receive a read-only projection only when the module sets `spectatable`. A module whose view would leak a secret turns it off: Imposter draws roles from the final lobby roster and its crew view carries the secret word, so it supports neither spectating nor mid-game seating.
- Every game snapshot carries the caller's canonical server id as `selfId`. Clients use it to find themselves in players, scoreboards and tiles, because the server can normalize identity (lowercased email, token session id) in ways a locally rebuilt id misses.
- The seed comes from `crypto`, so deals and shuffles are unpredictable to clients, and the seeded PRNG keeps a session replayable for debugging.
- Reaction times are measured from the server's go moment and the server's receive time, with a small server-owned latency allowance, so clients cannot forge the clock.
- Late joiners are seated only when a phase enters one of the module's `lateJoinPhases`. Round state is keyed by player id, missing means not acted, and a new player's score starts at zero.
- A collect phase advances early once every currently connected seat holder has acted. The shared round loop measures this against `ctx.activePlayers`, never `ctx.players`, so a disconnected seat holder cannot make the room wait out every timer. This rule once broke in every hand-rolled copy, which is why it lives in one place.
- Text options can hold private topic text, so public state omits them and a rematch uses defaults for them.
- Clients that predate `showWhen` simply show every option and still submit a valid configuration.
- Wordle: only the setter, who already knows the word, receives every contestant's live board. Contestants never receive each other's boards. In team modes the shared board is also sent as the player's own board, and is mirrored into the setter's `boards` list as one entry, so clients that only know solo Wordle still render it.

## Consequences

- A client bug can never reveal another player's secret, because the data never reaches it.
- Every new module has to decide `spectatable` and `lateJoinPhases` deliberately.

## Alternatives considered

- **Running games as Yjs apps:** rejected because every client would hold the full state, including secrets.

## Code

- `packages/sfu/server/games/types.ts`: `GameModule`, `GameMoveError`, `spectatable`, `lateJoinPhases`, `selfId`, `showWhen`
- `packages/sfu/server/games/engine.ts`: `GameSession`, `seatPendingIfBoundary`
- `packages/sfu/server/games/roundLoop.ts`: `allActivePlayersActed`, `createRoundLoop`
- `packages/sfu/server/games/rng.ts`: `createSeed`, `createRng`
- `packages/sfu/server/games/modules/reaction.ts`
- `packages/sfu/server/games/modules/imposter.ts`
- `packages/sfu/server/games/modules/wordle.ts`: `playerView`
- `packages/sfu/server/socket/handlers/gameHandlers.ts`: `broadcastGame`
