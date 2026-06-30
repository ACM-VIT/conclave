import { bluffModule } from "./modules/bluff.js";
import { imposterModule } from "./modules/imposter.js";
import { mostLikelyToModule } from "./modules/mostLikelyTo.js";
import { reactionModule } from "./modules/reaction.js";
import { triviaModule } from "./modules/trivia.js";
import { wordleModule } from "./modules/wordle.js";
import { wouldYouRatherModule } from "./modules/wouldYouRather.js";
import type { GameCatalogEntry, GameModule } from "./types.js";

// Register a game here (one line). The order is the order shown in the launcher.
const MODULES: GameModule[] = [
  triviaModule as GameModule,
  bluffModule as GameModule,
  wouldYouRatherModule as GameModule,
  mostLikelyToModule as GameModule,
  reactionModule as GameModule,
  imposterModule as GameModule,
  wordleModule as GameModule,
];

const REGISTRY = new Map<string, GameModule>(
  MODULES.map((module) => [module.id, module]),
);

export const getGameModule = (gameId: string): GameModule | undefined =>
  REGISTRY.get(gameId);

export const getGameCatalog = (): GameCatalogEntry[] =>
  MODULES.map((module) => ({
    id: module.id,
    name: module.name,
    description: module.description,
    minPlayers: module.minPlayers,
    maxPlayers: module.maxPlayers,
    options: module.options ?? [],
    hasLeaderboard: Boolean(module.hasLeaderboard),
  }));
