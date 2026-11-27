# 0020. Chess bot endgame search

- Status: Accepted
- Date: 2026-11-22

## Context

The built-in chess bot runs a small search inside a fixed node and time budget. With only material and piece-square scores it has no gradient in trivially won endgames such as K+R vs K, and it shuffles them into a draw. Its search starts from a bare FEN, which cannot express threefold repetition.

## Decision

- Evaluation adds a mop-up term when one side has a bare king against a winning material edge: it rewards pushing the losing king to the edge and bringing the winning king closer.
- `pickBotMove` takes the game's recent positions. When the bot is clearly winning, root moves that revisit an earlier position are penalized.
- In low-material endgames on medium and hard, the depth cap is extended so the bot can see a mating plan (K+R vs K needs about six plies). The node and time budget still bounds the work.

## Consequences

- The bot converts won endgames instead of drawing them.

## Code

- `packages/sfu/server/games/chessBot.ts`: `evaluate`, `pickBotMove`
- `packages/sfu/scripts/bot-strength.ts`
