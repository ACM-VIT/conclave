# Add a Game to Conclave

This guide explains how to add an in-meeting game to Conclave. Games are part of the Apps SDK surface, but they use a different runtime model from collaborative Yjs apps.

Use the game runtime when the server must own the rules. Good examples are trivia, bluffing games, reaction games, voting games, and hidden-role games.

Use a regular collaborative app when everyone can safely see and edit the same shared document, such as a whiteboard, notes, polls, or a checklist.

## What You Build

A Conclave game has two parts:

1. A server game module that owns the rules, state transitions, timers, scoring, and private information.
2. A web renderer that displays the public state plus the current player's private view.

The SFU game engine already handles sockets, room membership, admin checks, state broadcasts, private player views, and game cleanup. A new game should plug into those extension points. It should not require edits to core SFU handlers.

## Fast Start

Run the scaffold command from the repo root:

```bash
node packages/sfu/scripts/new-game.mjs quick-draw "Quick Draw"
```

The command creates:

```text
packages/sfu/server/games/modules/quickDraw.ts
apps/web/src/app/components/games/QuickDrawGame.tsx
```

It also updates:

```text
packages/sfu/server/games/registry.ts
apps/web/src/app/components/games/registry.tsx
```

After scaffolding, fill in the reducer, projections, and renderer. Then run:

```bash
CI=true corepack pnpm -C packages/sfu run typecheck
CI=true corepack pnpm -C apps/web run lint
node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json
CI=true corepack pnpm -C packages/apps-sdk run check:apps
```

## Files You Usually Touch

| Area | File | Purpose |
| --- | --- | --- |
| Server rules | `packages/sfu/server/games/modules/<game>.ts` | Authoritative game logic |
| Server catalog | `packages/sfu/server/games/registry.ts` | Adds the game to `game:list` |
| Web renderer | `apps/web/src/app/components/games/<Game>Game.tsx` | Renders the dock UI |
| Web renderer map | `apps/web/src/app/components/games/registry.tsx` | Maps `gameId` to renderer |
| Optional visual identity | `apps/web/src/app/components/games/covers.tsx` | Accent color and display name |

## Files You Should Not Need To Touch

These files are core runtime code. A normal game should not modify them:

- `packages/sfu/server/socket/handlers/gameHandlers.ts`
- `packages/sfu/server/games/engine.ts`
- `packages/sfu/server/games/types.ts`
- `packages/sfu/config/classes/Room.ts`
- `packages/apps-sdk/src/games/GameProvider.tsx`

If your game needs changes in one of those files, pause and check whether the feature should become a reusable runtime capability instead of a one-off game patch.

## Server Game Module

A game module implements `GameModule<State>`.

```ts
import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";

type Phase = "lobby" | "question" | "results";

type QuickDrawState = {
  phase: Phase;
  prompt: string | null;
  guesses: Record<string, string>;
};

export const quickDrawModule: GameModule<QuickDrawState> = {
  id: "quick-draw",
  name: "Quick Draw",
  description: "Draw from a prompt and vote on the winner",
  minPlayers: 2,
  maxPlayers: 12,
  tickMs: 500,

  setup(ctx: GameContext): QuickDrawState {
    return {
      phase: "lobby",
      prompt: null,
      guesses: {},
    };
  },

  onMove(state, move: GameMove, ctx): QuickDrawState {
    switch (move.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can start");
        }
        if (state.phase !== "lobby") {
          throw new GameMoveError("Already running");
        }
        return {
          ...state,
          phase: "question",
          prompt: ctx.rng.pick(["a rocket", "a sandwich", "a tiny castle"]),
        };
      }
      default:
        throw new GameMoveError(`Unknown move: ${move.type}`);
    }
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    return {
      phase: state.phase,
      prompt: state.prompt,
      totalPlayers: ctx.players.length,
      serverNow: ctx.now,
    };
  },

  playerView(state, playerId) {
    return {
      myGuess: state.guesses[playerId] ?? null,
    };
  },

  isFinished: (state) => state.phase === "results",
};
```

### Server Rules

- Keep all scoring and rule validation on the server.
- Throw `GameMoveError` for a rejected player action.
- Use `ctx.rng` for shuffles, prompts, roles, and random choices.
- Use `ctx.now` for deadlines and countdowns.
- Use `ctx.isAdmin(playerId)` for host-only moves.
- Keep reducers pure. Return a new state object when state changes.

## Public and Private Views

Every game sends two projections:

| Projection | Who receives it | Use it for |
| --- | --- | --- |
| `publicView` | The whole room | Shared phase, timers, public scores, revealed answers |
| `playerView` | One player only | Secret roles, private words, selected answer, personal status |

Do not put secrets in `publicView`. Hidden-role games should put the secret role or word in `playerView`, then reveal only safe information in `publicView` when the phase allows it.

## Moves

The web renderer calls:

```ts
move("answer", { choice: 2 });
```

The server receives:

```ts
{
  playerId: "user@example.com#session",
  type: "answer",
  payload: { choice: 2 }
}
```

Validate every payload. Do not trust the client to send a valid player id, choice, score, or phase.

For common player-target validation, use helpers from:

```text
packages/sfu/server/games/validation.ts
```

## Host Options

Games can expose host-configurable setup options. The launcher renders these automatically before starting the game.

```ts
options: [
  {
    id: "rounds",
    type: "number",
    label: "Rounds",
    min: 3,
    max: 10,
    default: 5,
    presets: [3, 5, 7],
  },
  {
    id: "pace",
    type: "select",
    label: "Pace",
    default: "normal",
    choices: [
      { value: "relaxed", label: "Relaxed" },
      { value: "normal", label: "Normal" },
      { value: "fast", label: "Fast" },
    ],
  },
  {
    id: "topic",
    type: "text",
    label: "Topic",
    default: "",
    placeholder: "Movies, space, team lore",
    maxLength: 120,
  },
],
```

Read options in `setup`:

```ts
import { numberOption, selectOption, textOption } from "../config.js";

const rounds = numberOption(ctx.config, "rounds", 5);
const pace = selectOption(ctx.config, "pace", "normal");
const topic = textOption(ctx.config, "topic", "");
```

The server normalizes client input before the game starts. Unknown keys are dropped. Invalid values fall back to defaults.

## Generated Content

Use generated content when a game needs fresh prompts, questions, word sets, or scenarios. The runtime supports this as a reusable server-side primitive:

1. Add a text option for the host input. Built-in games use `GAME_CONTENT_TOPIC_OPTION`.
2. Implement `generateContent(ctx)` on the game module.
3. Call `generateStructuredGameContent` with a JSON schema and a validator.
4. Read `ctx.content` in `setup`.
5. Keep a local fallback bank so the game still starts if AI is unavailable.

Example:

```ts
import {
  GAME_CONTENT_TOPIC_OPTION,
  cleanGeneratedText,
  generateStructuredGameContent,
  gameContentTopic,
} from "../aiContent.js";
import { numberOption } from "../config.js";

type Prompt = { text: string };

const parseGeneratedPrompts = (payload: unknown): Prompt[] | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const prompts = (payload as { prompts?: unknown }).prompts;
  if (!Array.isArray(prompts)) return null;
  const out = prompts
    .map((item) => cleanGeneratedText(item, 120))
    .filter((item): item is string => Boolean(item))
    .map((text) => ({ text }));
  return out.length > 0 ? out : null;
};

export const quickDrawModule: GameModule<QuickDrawState> = {
  // ...
  options: [
    GAME_CONTENT_TOPIC_OPTION,
    { id: "rounds", type: "number", label: "Rounds", min: 3, max: 8, default: 5 },
  ],

  generateContent(ctx) {
    const topic = gameContentTopic(ctx.config);
    if (!topic) return Promise.resolve(null);
    const rounds = numberOption(ctx.config, "rounds", 5);
    return generateStructuredGameContent({
      gameName: "Quick Draw",
      topic,
      instructions: `Create ${rounds} short drawing prompts.`,
      schemaName: "quick_draw_prompts",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompts: {
            type: "array",
            minItems: rounds,
            maxItems: rounds,
            items: { type: "string", maxLength: 120 },
          },
        },
        required: ["prompts"],
      },
      parse: parseGeneratedPrompts,
    });
  },

  setup(ctx) {
    const generated = Array.isArray(ctx.content) ? (ctx.content as Prompt[]) : [];
    const promptBank = generated.length > 0 ? generated : LOCAL_PROMPTS;
    // Build initial state from promptBank.
  },
};
```

Generation runs before `GameSession` is created. Reducers still stay pure, and a game module does not need to edit socket handlers.

SFU configuration:

```bash
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_WORKERS_AI_MODEL=cf/zai-org/glm-4.7-flash
SFU_GAME_AI_TIMEOUT_MS=25000
SFU_GAME_AI_WEB_SEARCH_ENABLED=1
SFU_GAME_AI_WEB_SEARCH_CONTEXT_SIZE=low
```

For local development, `npx wrangler login` can provide the OAuth token. The account id is still required. Production should use an API token with Workers AI access.

Web search is enabled by default for generated game content. Keep the context size at `low` unless a game truly needs deeper current-event grounding.

Run the live smoke test when changing generated content:

```bash
CLOUDFLARE_ACCOUNT_ID=... pnpm -C packages/sfu run test:game-ai
```

## Leaderboards

If your game has scores, set:

```ts
hasLeaderboard: true,
```

Then include a scoreboard in `publicView`:

```ts
scoreboard: ctx.players
  .map((player) => ({
    id: player.id,
    name: player.name,
    score: state.scores[player.id] ?? 0,
  }))
  .sort((a, b) => b.score - a.score),
```

The dock can render a compact leaderboard automatically during active phases.

## Web Renderer

Create a renderer in:

```text
apps/web/src/app/components/games/<Game>Game.tsx
```

The renderer receives:

```ts
import { type GameViewProps } from "./gameUi";

type QuickDrawPublic = {
  phase: "lobby" | "question" | "results";
  prompt: string | null;
};

type QuickDrawMe = {
  myGuess: string | null;
};

export default function QuickDrawGame({
  pub,
  me,
  isAdmin,
  move,
}: GameViewProps<QuickDrawPublic, QuickDrawMe>) {
  // Render the game UI here.
}
```

Keep the renderer as presentation code. It should read `pub` and `me`, collect user input, and call `move(type, payload)`. It should not duplicate server rules or compute authoritative scores.

## Register the Game

Add the server module to:

```text
packages/sfu/server/games/registry.ts
```

Add the web renderer to:

```text
apps/web/src/app/components/games/registry.tsx
```

If you want the lobby accent and fallback name to match the game, add entries in:

```text
apps/web/src/app/components/games/covers.tsx
```

## Review Checklist

Before opening a PR, check:

1. The server rejects illegal moves with `GameMoveError`.
2. Secrets only appear in `playerView` until they are meant to be public.
3. Timers use `ctx.now` and return `serverNow` for client countdowns.
4. Host-only moves use `ctx.isAdmin(move.playerId)`.
5. Player ids in payloads are validated against `ctx.players`.
6. The game can handle disconnects. Players are snapshotted at game start.
7. The launcher entry has clear `minPlayers`, `maxPlayers`, and description text.
8. `pnpm -C packages/sfu run typecheck` passes.
9. `pnpm -C apps/web run lint` passes.
10. `pnpm -C packages/apps-sdk run check:apps` passes.

## Related Docs

- [Apps SDK Docs Home](../README.md)
- [Runtime APIs and Hooks](../reference/runtime-apis.md)
- [Core Concepts](../reference/core-concepts.md)
- [Add a New App Integration](./add-a-new-app-integration.md)
- [Server Game Runtime README](../../../sfu/server/games/README.md)
