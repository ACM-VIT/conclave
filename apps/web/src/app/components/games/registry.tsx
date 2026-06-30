"use client";

import type React from "react";
import type { GameViewProps } from "./gameUi";
import TriviaGame from "./TriviaGame";
import BluffGame from "./BluffGame";
import WouldYouRatherGame from "./WouldYouRatherGame";
import MostLikelyToGame from "./MostLikelyToGame";
import ReactionGame from "./ReactionGame";
import ImposterGame from "./ImposterGame";
import WordleGame from "./WordleGame";

// Add a web renderer here (one line). The key is the game id from the SFU
// module. Everything else (launcher, stage routing) reads from this map.
export const GAME_RENDERERS: Record<string, React.ComponentType<GameViewProps>> = {
  trivia: TriviaGame as React.ComponentType<GameViewProps>,
  bluff: BluffGame as React.ComponentType<GameViewProps>,
  "would-you-rather": WouldYouRatherGame as React.ComponentType<GameViewProps>,
  "most-likely-to": MostLikelyToGame as React.ComponentType<GameViewProps>,
  reaction: ReactionGame as React.ComponentType<GameViewProps>,
  imposter: ImposterGame as React.ComponentType<GameViewProps>,
  wordle: WordleGame as React.ComponentType<GameViewProps>,
};

export const getGameRenderer = (
  gameId: string,
): React.ComponentType<GameViewProps> | undefined => GAME_RENDERERS[gameId];
