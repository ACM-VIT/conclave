/**
 * Tile adornments: a small, typed vocabulary for lighting up the participant
 * video tiles while a party game is running, so the video grid can double as
 * the game board.
 *
 * Layering, kept strict on purpose:
 *   - This module owns the PRIMITIVE. A game expresses a semantic
 *     {@link PlayerTileState} per tile (who acted, who was correct, who is out).
 *     A pure mapping resolves that meaning into visual {@link TileAdornment}
 *     primitives, themed by the game accent. No rendering lives here and there
 *     are no web-only or native-only dependencies, so every surface (web now,
 *     native later) can draw the same result and stay consistent.
 *   - The renderer (per platform) draws the primitives with real icons and
 *     styles, consuming these types only.
 *   - A game plugs in how to read its own public and private views through the
 *     per-game resolver registry below. That is the configurable seam.
 *
 * Design intent, mirrored by the default mapping: flat and restrained. State
 * carries meaning, never colour, and full-tile fills stay low opacity so the
 * face still reads over live video.
 */

/** The small glyph a tile can carry. The renderer picks the actual icon. */
export type TileMarkIcon = "check" | "cross" | "crown" | "bolt" | "clock" | "skull";

/**
 * Semantic colour role, resolved to a concrete colour by the renderer. `accent`
 * is the game accent; `positive`/`negative` are outcome colours; `neutral` is
 * the default chip look.
 */
export type TileTone = "neutral" | "accent" | "positive" | "negative";

/**
 * Semantic per-player state. This is what a game expresses; it carries meaning,
 * never colours. The viewer maps it to visuals.
 */
export type PlayerTileState = {
  /** Locked in during a collect phase (answered, tapped, voted). */
  acted?: boolean;
  /** Revealed round outcome. */
  outcome?: "correct" | "wrong";
  /** Out of play. */
  eliminated?: boolean;
  /** Current turn or spotlight. */
  active?: boolean;
  /** The local viewer's current pick (their live vote target), shown as a ring. */
  selected?: boolean;
  /** Won the round or the game, the reveal beat (crowned, accent washed). */
  winner?: boolean;
  /** 1-based leaderboard position. */
  rank?: number;
  /** Very short label, e.g. "+950" or "Too soon". */
  note?: string;
};

/**
 * The resolved visual primitives the renderer draws. `fill` and `dim` are
 * full-tile; `ring` insets on the tile edge; `mark` and `badge` sit in tile
 * chrome. A resolved adornment holds at most one of each so the tile stays
 * calm.
 */
export type TileAdornment = {
  /** Full-tile flat colour wash. Opacity is kept low so the face still reads. */
  fill?: { color: string; opacity: number };
  /** Full-tile dark scrim for an out or backgrounded tile. */
  dim?: boolean;
  /** Inset ring on the tile edge, e.g. the active spotlight. */
  ring?: { color: string };
  /** A single glyph, placed centre stage or tucked into a free corner. */
  mark?: { icon: TileMarkIcon; tone: TileTone; emphasis?: "center" | "corner" };
  /** A short text chip, e.g. a rank or a "+950" note. */
  badge?: { text: string; tone: TileTone };
};

/**
 * The fixed palette for tile tones. Positive and negative are fixed rather
 * than themed so a right answer always reads green and an out state always
 * reads warm red, independent of the game accent. Renderers must use
 * {@link resolveTileToneColor} instead of hardcoding these.
 */
export const TILE_COLORS = {
  positive: "#22A578",
  negative: "#E85046",
  neutralText: "#fafafa",
} as const;

/** Resolve a semantic tone to its concrete colour for the given game accent. */
export function resolveTileToneColor(tone: TileTone, accent: string): string {
  switch (tone) {
    case "accent":
      return accent;
    case "positive":
      return TILE_COLORS.positive;
    case "negative":
      return TILE_COLORS.negative;
    case "neutral":
      return TILE_COLORS.neutralText;
  }
}

/**
 * Fill opacities are deliberately low. A tile is live video of a person; a
 * wash is a hint layered over their face, never a paint job. Anything above
 * roughly 0.25 starts to read as a broken camera filter.
 */
const CORRECT_FILL_OPACITY = 0.18;
const WINNER_FILL_OPACITY = 0.24;

/**
 * Pure default mapping from semantic state to visual primitives, themed by the
 * game accent. This is the good-looking default; keeping the logic here means
 * every surface renders the same way.
 *
 * Composition, so the tile never gets noisy: at most one `fill`, one `mark`,
 * one `badge`, plus optional `ring` and `dim`. Precedence for the full-tile
 * fill and the primary mark is `eliminated` > `winner` > `outcome` > `acted`.
 * Rank always contributes its badge unless the player is eliminated, so a
 * leader who just answered still keeps the "#1" chip.
 *
 * @param state the game's semantic read of this tile, or null for none
 * @param accent the game accent colour (used for the accent tone)
 * @returns the primitives to draw, or null when there is nothing to show
 */
export function resolveTileAdornment(
  state: PlayerTileState | null | undefined,
  accent: string,
): TileAdornment | null {
  if (!state) return null;

  const adornment: TileAdornment = {};

  // Full-tile fill, dim and the primary mark follow one precedence so they
  // never fight over the tile. Only the winning branch sets them.
  if (state.eliminated) {
    adornment.dim = true;
    adornment.mark = { icon: "skull", tone: "negative", emphasis: "corner" };
    if (state.note) adornment.badge = { text: state.note, tone: "negative" };
  } else if (state.winner) {
    // The reveal beat: a soft accent wash, a matching ring, and a crown.
    adornment.fill = { color: accent, opacity: WINNER_FILL_OPACITY };
    adornment.ring = { color: accent };
    adornment.mark = { icon: "crown", tone: "accent", emphasis: "center" };
    if (state.note) adornment.badge = { text: state.note, tone: "accent" };
  } else if (state.outcome === "correct") {
    adornment.fill = {
      color: TILE_COLORS.positive,
      opacity: CORRECT_FILL_OPACITY,
    };
    adornment.ring = { color: TILE_COLORS.positive };
    adornment.mark = { icon: "check", tone: "positive", emphasis: "center" };
    if (state.note) adornment.badge = { text: state.note, tone: "positive" };
  } else if (state.outcome === "wrong") {
    // A wrong answer gets a quiet corner cross and nothing else. Washing or
    // dimming somebody's face over a missed trivia question punishes too hard.
    adornment.mark = { icon: "cross", tone: "neutral", emphasis: "corner" };
  } else if (state.acted) {
    // Locked in during a collect phase: a small accent check, no wash. It
    // reveals that the player acted without hinting whether they were right.
    adornment.mark = { icon: "check", tone: "accent", emphasis: "corner" };
  }

  // A short note with no branch of its own still earns a quiet neutral badge,
  // e.g. live vote counts on a tile during a vote phase.
  if (!adornment.badge && state.note) {
    adornment.badge = { text: state.note, tone: "neutral" };
  }

  // The current-turn and selection rings compose on top of any of the above,
  // but never displace an outcome ring already claimed by a stronger state.
  if (!adornment.ring && (state.active || state.selected)) {
    adornment.ring = { color: accent };
  }

  // Rank contributes its own badge and, for the leader, the crown. This is the
  // leader look that already exists, now produced by the shared mapping. Rank
  // never overrides an eliminated player's negative badge.
  if (!state.eliminated && typeof state.rank === "number" && state.rank >= 1) {
    const isLeader = state.rank === 1;
    if (isLeader) {
      // The crown only claims the corner if nothing already sits there, and
      // the "#1" chip never displaces a richer badge like a "+950" reveal note.
      if (!adornment.mark || adornment.mark.emphasis === "center") {
        adornment.mark = { icon: "crown", tone: "accent", emphasis: "corner" };
      }
      if (!adornment.badge) adornment.badge = { text: "#1", tone: "accent" };
    } else if (!adornment.badge) {
      adornment.badge = { text: `#${state.rank}`, tone: "neutral" };
    }
  }

  const hasAnything =
    adornment.fill ||
    adornment.dim ||
    adornment.ring ||
    adornment.mark ||
    adornment.badge;
  return hasAnything ? adornment : null;
}

/**
 * How a game reads its views into a {@link PlayerTileState} for one tile. This
 * is the configurable seam: a game registers one of these and the renderer
 * calls it per tile.
 *
 * A resolver must only read what the given views genuinely expose and must
 * never invent data; return null when there is nothing to say for this tile.
 *
 * @param args.gameId the active game id
 * @param args.publicView the game's room-wide public view payload
 * @param args.privateView the local viewer's private view, for self treatments
 *   such as marking the tile they voted for; never contains other players'
 *   secrets by construction
 * @param args.playerId the id of the tile being adorned
 * @param args.viewerId the local viewer's id, for private or self treatments
 */
export type TileResolverArgs = {
  gameId: string;
  publicView: unknown;
  privateView?: unknown;
  playerId: string;
  viewerId: string | null;
};

export type TileStateResolver = (args: TileResolverArgs) => PlayerTileState | null;

/**
 * An interactive affordance on a tile: while present, tapping the tile sends
 * this move. This is how the video grid becomes the controller, e.g. tap a
 * face to vote in imposter or most likely to. The renderer draws the hover
 * affordance and dispatches through the game-agnostic `move(type, payload)`.
 */
export type TileAction = {
  /** The move type to send, e.g. "vote". */
  type: string;
  /** The move payload, e.g. { target: playerId }. */
  payload?: unknown;
  /** Short sentence-case verb shown on hover, e.g. "Vote". */
  label: string;
};

/**
 * How a game decides whether a tile is currently tappable for the viewer.
 * Return null when the tile is not a valid target (wrong phase, self target
 * where the game forbids it, viewer not seated). The renderer additionally
 * gates on read-only mode and game membership.
 */
export type TileActionResolver = (args: TileResolverArgs) => TileAction | null;

const tileResolvers = new Map<string, TileStateResolver>();
const tileActionResolvers = new Map<string, TileActionResolver>();

/**
 * Register how a game maps its views to tile state. A later registration for
 * the same id replaces the earlier one.
 */
export function registerTileResolver(
  gameId: string,
  resolver: TileStateResolver,
): void {
  tileResolvers.set(gameId, resolver);
}

/** Look up the tile resolver a game registered, if any. */
export function getTileResolver(gameId: string): TileStateResolver | undefined {
  return tileResolvers.get(gameId);
}

/**
 * Register how a game turns a tile into a live control for the viewer. A later
 * registration for the same id replaces the earlier one.
 */
export function registerTileAction(
  gameId: string,
  resolver: TileActionResolver,
): void {
  tileActionResolvers.set(gameId, resolver);
}

/** Look up the tile action resolver a game registered, if any. */
export function getTileAction(gameId: string): TileActionResolver | undefined {
  return tileActionResolvers.get(gameId);
}
