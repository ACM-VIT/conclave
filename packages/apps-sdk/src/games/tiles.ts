export type TileMarkIcon = "check" | "cross" | "crown" | "bolt" | "clock" | "skull";

export type TileTone = "neutral" | "accent" | "positive" | "negative";

export type PlayerTileState = {
  acted?: boolean;
  outcome?: "correct" | "wrong";
  eliminated?: boolean;
  active?: boolean;
  selected?: boolean;
  winner?: boolean;
  rank?: number;
  note?: string;
};

export type TileAdornment = {
  fill?: { color: string; opacity: number };
  dim?: boolean;
  ring?: { color: string };
  mark?: { icon: TileMarkIcon; tone: TileTone; emphasis?: "center" | "corner" };
  badge?: { text: string; tone: TileTone };
};

export const TILE_COLORS = {
  positive: "#22A578",
  negative: "#E85046",
  neutralText: "#fafafa",
} as const;

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

const CORRECT_FILL_OPACITY = 0.18;
const WINNER_FILL_OPACITY = 0.24;

export function resolveTileAdornment(
  state: PlayerTileState | null | undefined,
  accent: string,
): TileAdornment | null {
  if (!state) return null;

  const adornment: TileAdornment = {};

  if (state.eliminated) {
    adornment.dim = true;
    adornment.mark = { icon: "skull", tone: "negative", emphasis: "corner" };
    if (state.note) adornment.badge = { text: state.note, tone: "negative" };
  } else if (state.winner) {
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
    adornment.mark = { icon: "cross", tone: "neutral", emphasis: "corner" };
  } else if (state.acted) {
    adornment.mark = { icon: "check", tone: "accent", emphasis: "corner" };
  }

  if (!adornment.badge && state.note) {
    adornment.badge = { text: state.note, tone: "neutral" };
  }

  if (!adornment.ring && (state.active || state.selected)) {
    adornment.ring = { color: accent };
  }

  if (!state.eliminated && typeof state.rank === "number" && state.rank >= 1) {
    const isLeader = state.rank === 1;
    if (isLeader) {
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

export type TileResolverArgs = {
  gameId: string;
  publicView: unknown;
  privateView?: unknown;
  playerId: string;
  viewerId: string | null;
};

export type TileStateResolver = (args: TileResolverArgs) => PlayerTileState | null;

export type TileAction = {
  type: string;
  payload?: unknown;
  label: string;
};

export type TileActionResolver = (args: TileResolverArgs) => TileAction | null;

const tileResolvers = new Map<string, TileStateResolver>();
const tileActionResolvers = new Map<string, TileActionResolver>();

export function registerTileResolver(
  gameId: string,
  resolver: TileStateResolver,
): void {
  tileResolvers.set(gameId, resolver);
}

export function getTileResolver(gameId: string): TileStateResolver | undefined {
  return tileResolvers.get(gameId);
}

export function registerTileAction(
  gameId: string,
  resolver: TileActionResolver,
): void {
  tileActionResolvers.set(gameId, resolver);
}

export function getTileAction(gameId: string): TileActionResolver | undefined {
  return tileActionResolvers.get(gameId);
}
