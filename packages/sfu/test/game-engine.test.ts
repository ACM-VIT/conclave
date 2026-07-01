import { describe, expect, it } from "vitest";
import { GameSession } from "../server/games/engine.js";
import type { GameContext, GameModule, GamePlayer } from "../server/games/types.js";

type State = { phase: "lobby" };

const players: GamePlayer[] = [{ id: "host", name: "Host" }];

const moduleWithTextConfig: GameModule<State> = {
  id: "config-test",
  name: "Config Test",
  description: "Exercises public config redaction",
  minPlayers: 1,
  maxPlayers: 4,
  options: [
    { id: "topic", type: "text", label: "Topic", default: "", maxLength: 120 },
    { id: "rounds", type: "number", label: "Rounds", min: 1, max: 10, default: 3 },
    {
      id: "pace",
      type: "select",
      label: "Pace",
      default: "normal",
      choices: [
        { value: "normal", label: "Normal" },
        { value: "fast", label: "Fast" },
      ],
    },
  ],
  setup: (_ctx: GameContext) => ({ phase: "lobby" }),
  onMove: (state: State) => state,
  getPhase: (state: State) => state.phase,
  publicView: () => ({}),
  playerView: () => ({}),
};

describe("GameSession public state", () => {
  it("omits free-text config from the public rematch config", () => {
    const session = new GameSession({
      module: moduleWithTextConfig,
      players,
      adminIds: ["host"],
      hostId: "host",
      config: {
        topic: "private team lore",
        rounds: 5,
        pace: "fast",
      },
    });

    expect(session.getPublicState(0).config).toEqual({
      rounds: 5,
      pace: "fast",
    });
  });
});
