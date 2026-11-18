export type TriviaMove =
  | { type: "start" }
  | { type: "answer"; choice: number }
  | { type: "skip" }
  | { type: "next" };

export type LongShotMove =
  | { type: "start" }
  | { type: "answer"; text: string }
  | { type: "skip" }
  | { type: "next" };

export type BluffMove =
  | { type: "start" }
  | { type: "submit"; text: string }
  | { type: "choose"; optionId: string }
  | { type: "next" }
  | { type: "skip" };

export type WouldYouRatherMove =
  | { type: "start" }
  | { type: "choose"; option: 0 | 1 }
  | { type: "next" }
  | { type: "skip" };

export type MostLikelyToMove =
  | { type: "start" }
  | { type: "vote"; target: string }
  | { type: "next" }
  | { type: "skip" };

export type ReactionMove =
  | { type: "start" }
  | { type: "tap" }
  | { type: "next" };

export type ImposterMove =
  | { type: "start" }
  | { type: "callVote" }
  | { type: "vote"; target: string }
  | { type: "tally" };

export type WordleMove =
  | { type: "start" }
  | { type: "setWord"; word: string }
  | { type: "guess"; word: string }
  | { type: "passTurn" }
  | { type: "nextRound" };

export type ChessMove =
  | { type: "start" }
  | { type: "move"; from: string; to: string; promotion?: "q" | "r" | "b" | "n" }
  | { type: "resign" }
  | { type: "offerDraw" }
  | { type: "acceptDraw" }
  | { type: "declineDraw" }
  | { type: "requestTakeback" }
  | { type: "acceptTakeback" }
  | { type: "declineTakeback" };
