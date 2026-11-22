# 0005. TypeScript sources drive generated native code

- Status: Accepted
- Date: 2026-11-22

## Context

Web and native must agree on socket.io event names, design tokens and chat `:name:` shortcuts. Hand-maintained copies drift. The generators run in CI with plain Node, where adding a TypeScript loader is extra weight.

## Decision

The TypeScript source is the single source of truth, and native code is generated from it:

- `SFU_EVENTS` in `packages/meeting-core/src/sfu-events.ts` becomes the Swift `SfuEvents` enum. The generator reads the TypeScript file and evaluates only the `SFU_EVENTS` object literal, so it needs no TS loader.
- The native tokens in `packages/ui-tokens/src/tokens.ts` become Swift, asset catalogs and Android XML. The generator imports the `.ts` file directly and relies on Node 22.22 or later stripping erasable TypeScript, so references and spreads resolve from the canonical source.
- `EMOJI_SHORTCODES` in `apps/web/src/app/lib/emoji-shortcodes.ts` becomes the Swift shortcode table. `--check` also fails when the web matching patterns change, because the Swift matcher ports those patterns by hand.

Each generator has a `--check` mode that `pnpm check` runs, so a stale output fails CI. Re-run the generator after editing its source.

## Consequences

- One edit in TypeScript reaches every platform.
- The token generator needs Node 22.22 or later.
- The Swift shortcode matcher still has to be ported by hand when the patterns change; the check only flags it.

## Alternatives considered

- **Hand-written native copies:** rejected because they drift silently.
- **A TS loader such as tsx in the generators:** rejected to keep CI generators plain Node.

## Code

- `packages/meeting-core/scripts/gen-swift-events.mjs`
- `packages/ui-tokens/scripts/gen-native-tokens.mjs`: `renderNativeTokens`
- `scripts/gen-native-emoji-shortcodes.mjs`
- `package.json`: `check:swift-events`, `check:native-tokens`, `check:native-emoji`
