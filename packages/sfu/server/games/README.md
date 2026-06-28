# Game runtime (server-authoritative)

This is the **second app archetype** for Conclave, parallel to the collaborative
apps relay (`appsHandlers.ts` + Yjs). Where the apps relay is a dumb broadcaster
of a shared CRDT (every client converges on identical, fully-visible state), the
game runtime keeps canonical state **only on the server** and sends each client a
_projection_:

- `publicView` -> broadcast to the whole room (`game:state`)
- `playerView` -> emitted privately to a single player (`game:view`)

That split is what makes **hidden information** (secret roles, private words,
unrevealed answers) possible. A CRDT cannot hide anything from anyone.

## Pieces

| File | Role |
| --- | --- |
| `types.ts` | `GameModule` contract, wire payloads, `GameMoveError` |
| `validation.ts` | reusable move validators for common server-authoritative rules |
| `rng.ts` | seeded PRNG (server-only randomness for shuffles/deals) |
| `engine.ts` | `GameSession` owns authoritative state, applies moves, projects views |
| `registry.ts` | maps `gameId` to module |
| `modules/*.ts` | the games themselves (pure reducers) |
| `../socket/handlers/gameHandlers.ts` | socket wiring: validation, broadcast loop, per-player emit |

The session/tick timer is owned by `Room` (`room.gameSession`, `room.gameTickTimer`)
and torn down in `Room.close()` via `clearGame()`.

## Socket contract

| Event | Dir | Ack | Purpose |
| --- | --- | --- | --- |
| `game:list` | c->s | yes | available games catalog |
| `game:start` | c->s | yes | admin starts a game (snapshots current participants as players) |
| `game:move` | c->s | yes | a player submits a validated move |
| `game:end` | c->s | yes | admin ends the game |
| `game:getState` | c->s | yes | public state + your private view (reconnect/late join) |
| `game:state` | s->room | no | public projection on every change |
| `game:view` | s->player | no | **private** projection (hidden-info boundary) |
| `game:snapshot` | s->client | no | targeted join/reconnect snapshot: active game, private view, and vote |
| `game:ended` | s->room | no | game cleared |

## Adding a game

Full contributor guide: `packages/apps-sdk/docs/guides/add-a-game.md`.

1. Create `modules/<id>.ts` exporting a `GameModule<YourState>`:
   - `setup(ctx)`: build initial state with `ctx.rng` (seeded) and `ctx.players`.
   - `onMove(state, move, ctx)`: return next state; `throw new GameMoveError(...)`
     to reject. Gate admin-only moves with `ctx.isAdmin(move.playerId)`.
     Use helpers from `validation.ts` for common payload checks such as selecting
     another player.
   - `onTick(state, ctx)` + `tickMs`: for deadlines/countdowns (return the same
     reference to signal "no change").
   - `getPhase(state)`: coarse label for the host UI.
   - `publicView(state, ctx)`: **must not leak secrets**. Include `ctx.now` as
     `serverNow` if you use deadlines so clients can run a skew-free countdown.
   - `playerView(state, playerId, ctx)`: this player's private slice.
2. Register it in `registry.ts`.
3. Add a web renderer in `apps/web/src/app/components/games/` and route it in
   `apps/web/src/app/components/games/registry.tsx`. The renderer is pure
   presentation: it reads the two views and calls `move(type, payload)`. It
   holds **no** game logic.

## Current games

- `trivia`: Kahoot/Deezer-style timed quiz; speed-weighted scoring.
- `imposter`: Spyfall-style social deduction; exercises the hidden-info path
  (imposter and crew receive different `playerView`s).

## Known gaps / next

- Players are snapshotted at start; mid-game disconnects leave a stale seat
  (public view still lists them; their private view simply stops being sent).
- One game per room at a time (mirrors the single-`activeAppId` apps model).
- Next archetype work: bind game seats to participant **video tiles** (badges,
  turn rings, eliminated-tile dimming) and drive phase-based mute/spotlight.
