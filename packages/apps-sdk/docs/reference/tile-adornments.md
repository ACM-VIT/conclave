# Tile Adornments

Tile adornments let a game light up the participant video tiles, so the video grid doubles as the game board. A trivia player's tile shows a check the moment they answer and washes green when they were right. During a vote, tapping a face casts the vote. The people in the call become the interface.

This page explains the primitive, how to plug a game into it, and the safety rules that keep it correct.

## The Two Layers

The system is split so games express meaning and the platform owns the look.

1. A game resolves its views into a semantic `PlayerTileState` per tile. It says things like "this player has acted" or "this player won". It never picks colors or icons.
2. A pure mapping, `resolveTileAdornment(state, accent)`, turns that meaning into visual `TileAdornment` primitives, themed by the game accent. The web renderer draws those primitives. A future native renderer can draw the same ones and stay consistent.

Everything lives in `packages/apps-sdk/src/games/tiles.ts` and is exported from `@conclave/apps-sdk`. The web renderer is `apps/web/src/app/components/games/GameTileOverlay.tsx`, and per game wiring lives in `apps/web/src/app/components/games/tileResolvers.ts`.

## PlayerTileState: What a Game Can Say

| Field | Meaning | Default visual |
| --- | --- | --- |
| `acted` | Locked in during a collect phase (answered, tapped, voted) | Small accent check chip in the corner |
| `outcome: "correct"` | Revealed round outcome, right | Soft green wash, green ring, centered check, optional note badge |
| `outcome: "wrong"` | Revealed round outcome, wrong | Quiet neutral cross in the corner, nothing else |
| `eliminated` | Out of play | Dark scrim, corner skull, negative note badge |
| `active` | Current turn or spotlight | Accent ring |
| `selected` | The local viewer's own current pick | Accent ring |
| `winner` | Won the round or the game | Soft accent wash, accent ring, centered crown, accent note badge |
| `rank` | 1-based leaderboard position | `#1` accent chip with a crown for the leader, neutral `#N` chip otherwise |
| `note` | Very short label, for example `+950` or `2 votes` | Rendered as the badge text |

Composition rules, enforced by the mapping so tiles stay calm:

- At most one fill, one mark, and one badge per tile, plus an optional ring and scrim.
- Precedence for the main treatment is `eliminated`, then `winner`, then `outcome`, then `acted`.
- Rank contributes its chip unless the player is eliminated, and the leader's `#1` never displaces a richer badge such as a `+950` reveal note.
- A `note` with no stronger branch still renders as a quiet neutral badge. That is how live vote counts appear during a vote.

## Tones and Colors

Marks and badges carry a `TileTone`: `neutral`, `accent`, `positive`, or `negative`. Renderers resolve tones with `resolveTileToneColor(tone, accent)`, which maps `positive` and `negative` to the fixed palette in `TILE_COLORS` and `accent` to the game accent. Do not hardcode these colors in a renderer.

Design intent, which the defaults encode: a tile is live video of a person. Fills stay at low opacity so the face always reads. A wrong answer earns a quiet cross, not a punishing wash. Nothing pulses, shimmers, or loops.

## Plugging In a Game: registerTileResolver

A game registers one resolver that reads its views into a `PlayerTileState` for one tile. The renderer calls it for every tile.

```ts
import { registerTileResolver } from "@conclave/apps-sdk";

registerTileResolver("my-game", ({ publicView, privateView, playerId }) => {
  const view = publicView as MyGamePublicView;
  if (view.phase !== "voting") return null;
  return {
    acted: view.votedPlayerIds.includes(playerId),
    selected: (privateView as MyGameView | null)?.yourVote === playerId,
  };
});
```

Resolver arguments (`TileResolverArgs`):

- `gameId`: the active game id.
- `publicView`: the game's room-wide public view payload.
- `privateView`: the local viewer's own private view. Use it only for viewer-relative treatments, such as marking the tile they voted for. It never contains other players' secrets by construction.
- `playerId`: the tile being adorned.
- `viewerId`: the local viewer's id.

Rules that keep resolvers correct:

- Only read what the views genuinely expose. Never invent data.
- Return `null` when there is nothing to say for this tile. Unknown ids must render nothing, not a guess.
- Leaderboard rank is applied universally by the renderer from `publicView.scoreboard`, so resolvers do not reimplement it.

## Making Tiles Tappable: registerTileAction

An action resolver turns a tile into a live control for the viewer. While it returns an action, tapping the tile sends that move. This is how tap-to-vote works.

```ts
import { registerTileAction } from "@conclave/apps-sdk";

registerTileAction("my-game", ({ publicView, playerId, viewerId }) => {
  const view = publicView as MyGamePublicView;
  if (view.phase !== "voting") return null;
  if (playerId === viewerId) return null;
  return { type: "vote", payload: { target: playerId }, label: "Vote" };
});
```

The renderer owns the rest: the hover affordance (accent ring plus a label chip), dispatch through the game-agnostic `move(type, payload)`, an in-flight guard, and an accessible label such as "Vote Sam". It also gates actions on read-only mode, game membership, and the game not being finished, so resolvers only express game rules:

- Return `null` for invalid targets, the wrong phase, or self targets where the game forbids them.
- The payload must match the move contract your server module decodes. The server remains the authority; an illegal tap is rejected there like any other move.

## Projecting Tile State From the Server

Some tile facts only the server knows, such as who has answered the current trivia question. Expose them as a compact, additive map in the game's `publicView`, keyed by player id:

```ts
// In publicView, during the answering phase:
tiles[playerId] = { acted: true };
// At reveal:
tiles[playerId] = { outcome: "correct", note: "+950" };
```

The hidden-information rule still applies: `publicView` must never leak a secret. Saying that a player answered is safe. Saying what they answered is not, until the reveal makes it public. When in doubt, ask whether every participant is allowed to know the fact right now.

Many games need no server change at all. If the public view already exposes vote counts, voter ids, or a winner id, the resolver can derive everything client-side.

## Checklist for Adding Tile Support to a Game

1. Decide the semantic states your game can express per phase, using the table above.
2. If a needed fact is server-only, add an additive `tiles` map (or equivalent fields) to `publicView`. Never leak secrets.
3. Register a state resolver in `apps/web/src/app/components/games/tileResolvers.ts`.
4. If tiles should be tappable in some phase, register an action resolver next to it.
5. Fail safe everywhere: `null` for unknown ids, missing fields, or wrong phases.
6. `pnpm -C packages/sfu exec tsc --noEmit` and `pnpm -C apps/web exec tsc --noEmit` pass, and the game tests stay green.

## Related Docs

- [Add a Game to Conclave](../guides/add-a-game.md)
- [Core Concepts](./core-concepts.md)
- [Runtime APIs and Hooks](./runtime-apis.md)
- [Server Game Runtime README](../../../sfu/server/games/README.md)
