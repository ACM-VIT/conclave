# @conclave/ui-tokens

The shared design-system tokens and primitives for Conclave: one flat,
gradient-free visual language (solid surfaces, hairline borders, a single
coral accent) consumed by the web app and server-rendered email surfaces.

## Entry points

| Import | Contents |
| --- | --- |
| `@conclave/ui-tokens` | Platform-agnostic tokens (`color`, `font`, `radius`, …) + core helpers |
| `@conclave/ui-tokens/web` | React DOM primitives (controls, avatars, and tile labels) |
| `src/tokens.css` | Tailwind v4 bridge kept aligned with `tokens.ts` |

Import React primitives from `/web`; the root entry deliberately exports only
tokens and platform-agnostic helpers.

## Rules

- No gradients, anywhere. Flat solid surfaces + border + the lone coral
  accent (`#F95F4A`).
- Keep the small CSS bridge aligned with `tokens.ts` when changing a token.
