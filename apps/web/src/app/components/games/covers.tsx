// Per-game identity: a single accent colour + display name. Used for the lobby
// spotlight tint and overline. Deliberately minimal - no artwork, no glyphs.

const GAME_ACCENTS: Record<string, string> = {
  trivia: "#3B8EE0",
  bluff: "#8B7BF0",
  "would-you-rather": "#22A578",
  "most-likely-to": "#E06392",
  reaction: "#E85046",
  imposter: "#E0863A",
  wordle: "#6AAA64",
  chess: "#C08552",
};

const GAME_NAMES: Record<string, string> = {
  trivia: "Trivia",
  bluff: "Bluff",
  "would-you-rather": "Would You Rather",
  "most-likely-to": "Most Likely To",
  reaction: "Reaction",
  imposter: "Imposter",
  wordle: "Wordle",
  chess: "Chess",
};

export const accentFor = (gameId?: string): string =>
  (gameId && GAME_ACCENTS[gameId]) || "#F95F4A";

export const nameFor = (gameId?: string): string | undefined =>
  gameId ? GAME_NAMES[gameId] : undefined;
