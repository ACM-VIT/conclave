// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GamesPanel } from "../src/app/components/games/GamesPanel";

const game = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@conclave/apps-sdk", () => ({
  useGame: () => game.current,
}));

const catalog = [
  {
    id: "trivia",
    name: "Trivia",
    description: "Quick-fire quiz",
    minPlayers: 1,
    maxPlayers: 50,
    options: [],
    hasLeaderboard: true,
  },
  {
    id: "imposter",
    name: "Imposter",
    description: "Spot the faker in the room",
    minPlayers: 3,
    maxPlayers: 3,
    options: [],
    hasLeaderboard: false,
  },
];

const done = async () => ({ success: true });

const setGame = (overrides: Record<string, unknown> = {}) => {
  game.current = {
    catalog,
    vote: null,
    isAdmin: true,
    isReadOnly: false,
    userId: "me",
    startGame: vi.fn(done),
    endGame: vi.fn(done),
    openVote: vi.fn(done),
    castVote: vi.fn(done),
    cancelVote: vi.fn(done),
    ...overrides,
  };
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => root.render(<GamesPanel onClose={() => {}} />));
};

const row = (name: string) =>
  Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.startsWith(name),
  );

it("lists each game with its player range and starts a game without options in one click", async () => {
  setGame();
  await render();

  expect(row("Trivia")?.textContent).toContain("1-50 players");
  expect(row("Imposter")?.textContent).toContain("3 players");
  const docs = Array.from(container.querySelectorAll("a")).find(
    (link) => link.textContent?.trim() === "Add your own game",
  );
  expect(docs?.getAttribute("target")).toBe("_blank");

  await act(async () => row("Trivia")?.click());
  expect(game.current.startGame).toHaveBeenCalledWith("trivia");
});

it("tells an observer they can only watch, and keeps every game closed to them", async () => {
  setGame({ isReadOnly: true });
  await render();

  expect(container.textContent).toContain("Observers can watch but not start games.");
  expect(row("Trivia")?.disabled).toBe(true);
  expect(container.textContent).not.toContain("Put it to a vote");
});

it("tells a participant the host is choosing, and keeps the games closed to them", async () => {
  setGame({ isAdmin: false });
  await render();

  expect(container.textContent).toContain("The host is picking a game.");
  expect(row("Imposter")?.disabled).toBe(true);
});

it("marks the game this viewer voted for as pressed", async () => {
  setGame({
    vote: {
      candidates: catalog,
      tally: { trivia: 2, imposter: 0 },
      votes: { me: "trivia", them: "trivia" },
      totalPlayers: 3,
    },
  });
  await render();

  expect(container.textContent).toContain("2 of 3 voted");
  expect(row("Trivia")?.getAttribute("aria-pressed")).toBe("true");
  expect(row("Trivia")?.textContent).toContain("Your pick");
  expect(row("Imposter")?.getAttribute("aria-pressed")).toBe("false");
  expect(container.textContent).toContain("Start Trivia");
});
