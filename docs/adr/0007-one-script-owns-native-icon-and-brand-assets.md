# 0007. One script owns the native icon and brand assets

- Status: Accepted
- Date: 2026-11-22

## Context

`packages/ui-tokens/scripts/gen-native-icons.py` converts Material Symbols and the Conclave mark into Compose vectors, Android drawables, Darwin app and CallKit icons and the SF Symbol catalog. Some of those outputs live in folders shared with hand-written resources. The operating system draws several of them (status bar, notifications, PiP actions, themed launcher icons and the CallKit template) using alpha only.

## Decision

- The generator owns the Darwin brand asset folders whole, so a stale or stray file there fails `--check`. In the shared Android `res/drawable` folder, only files carrying the generator's header count as its outputs, and a drawable it no longer emits is reported as extra.
- Drawable names must be legal Android resource names, because hand-written Skip bridges in the library module resolve them by name.
- System-tinted art is opaque white, and template art keeps SVG's default paint, because the system uses alpha only.
- The 24 dp status icon is the diamond alone in the 20 dp live area, because the letters would be 1.1 dp strokes at that size.
- Adaptive icon layers scale the 400 unit mark to 66 dp, centred in the 108 dp canvas, so it fits the 66 dp safe zone.
- Upstream `auto_awesome` uses implicit 24 px coordinates. It is an exact, pinned exception to the strict font960 profile.
- The script and its tests stay compatible with Python 3.9, the macOS system `python3`. For example the tests use an explicit length check instead of `zip(strict=True)`, which needs 3.10.
- Each output carries a provenance line with the manifest and generator SHA-256 and a per-vector input SHA-256, and the Compose vectors open with one Material Symbols license notice (Apache License, Version 2.0, with Conclave's conversion note and the source commit). The comment lint allows exactly these, and only in the files the generator writes.

## Consequences

- Any change to the generator changes the provenance hashes, so every output must be regenerated in the same change.
- Hand-written drawables can share the folder without being deleted.

## Alternatives considered

- **Owning the whole Android drawable folder:** rejected because the app keeps hand-written drawables there.

## Code

- `packages/ui-tokens/scripts/gen-native-icons.py`: `DRAWABLES`, `APP_ICON`, `ADDITIVE_24PX`, `WHITE`, `GENERATED_MARK`
- `packages/ui-tokens/scripts/gen-native-icons.test.py`
- `scripts/quality/comments/policy.mjs`: `isProvenanceHash`
