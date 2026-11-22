# 0006. One flat design token source, with platform semantics in native adapters

- Status: Accepted
- Date: 2026-11-22

## Context

`@conclave/ui-tokens` feeds the web (Tailwind v4 through `tokens.css`) and native (generated Swift, asset catalogs and Android XML). Conclave's visual language is flat: solid surfaces, borders and one coral accent, with no shadows, glows or gradients. iOS and Android also have their own semantic colors and text styles that adapt to appearance and accessibility settings.

## Decision

- Web colors are solid hex so Tailwind opacity modifiers such as `bg-accent/15` work. There are no shadow, glow or elevation tokens.
- `tokens.css` mirrors the web values in `tokens.ts` by hand. Keep the two in sync.
- Spacing on the web is Tailwind's own scale. The tokens do not override it, so existing utilities keep working.
- PolySans is the single sans face. Bulky Wide is the only expressive face and is used for headings only. There is no mono font token.
- Motion has an instant tier and one fast tier, and no slow or decorative duration.
- The native token namespace is separate from the web exports and the `tokens` aggregate, so web values never change because of native work.
- Platform semantics stay in the native adapters: dynamic UIKit roles (for example dark `secondaryLabel` and `systemRed`), system text styles, system fonts, capsule shapes and iOS green switches. Never replace a dynamic role with a sampled hex value. Native space values are points on iOS and dp on Android, and typography stays in platform text styles.
- Launch colors are static. App backgrounds use `systemGroupedBackground`.
- The in-call scheme is its own scheme even where its values match dark, and it never follows light appearance.
- On iOS, Leave uses dynamic `systemRed` at standard contrast and switches to the fixed `leaveHighContrast` fill only under Increase Contrast, where the white glyph reads at 4.555:1. The owner approved this on 2026-10-26.
- Avatar colors are identity art in the web Facehash order, never UI accents.
- The Android adaptive icon tile is the stage color in every appearance, so `ic_launcher_background` has no night variant.

## Consequences

- Web and native share one palette without forcing native onto web semantics.
- `tokens.css` can drift from `tokens.ts`, since nothing checks it.

## Alternatives considered

- **Sampling system colors into hex tokens:** rejected because they stop adapting to dark mode and accessibility settings.
- **A shadow or elevation scale:** rejected by the flat design rule.

## Code

- `packages/ui-tokens/src/tokens.ts`: `color`, `space`, `font`, `motion`, `native`
- `packages/ui-tokens/src/tokens.css`
- `packages/ui-tokens/scripts/gen-native-tokens.mjs`: `renderNativeTokens`
