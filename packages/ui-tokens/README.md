# @conclave/ui-tokens

The shared design-system tokens and primitives for Conclave: one flat,
gradient-free visual language (solid surfaces, hairline borders, a single
coral accent) consumed by both the web app and the native app.

## Entry points

| Import | Contents |
| --- | --- |
| `@conclave/ui-tokens` | Platform-agnostic tokens (`color`, `font`, `radius`, …) + core helpers |
| `@conclave/ui-tokens/web` | React DOM primitives (buttons, tile, panels, controls) |
| `@conclave/ui-tokens/native` | React Native primitives (buttons, tile) |
| `tailwind-tokens.cjs` | The same tokens as a Tailwind preset |
| `src/tokens.css` | The same tokens as CSS custom properties |

Import primitives from the platform-specific entry (`/web` or `/native`) so
the wrong platform's React renderer is never pulled into a bundle — the root
entry deliberately exports tokens and helpers only.

## Rules

- No gradients, anywhere. Flat solid surfaces + border + the lone coral
  accent (`#F95F4A`).
- Tokens are the single source of truth: web, native, Tailwind, and CSS all
  read from `src/tokens.ts`.
