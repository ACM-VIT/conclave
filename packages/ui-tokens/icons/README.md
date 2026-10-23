# Native icon inputs

Build-time only, offline, finite WP1 selection. From the repository root:

- `pnpm run check:native-icons`: read-only drift check; fails on missing, stale or extra outputs and never writes.
- `pnpm run generate:native-icons`: validates every input first, stages all outputs, then replaces only its enumerated files.
- `pnpm run test:native-icons`: converter semantics, independent geometry, archived-semantics replay, fail-closed validation and drift.

The generator uses the Python standard library only and never fetches inputs.

Material Symbols by Google, from commit `49d4db35df873165d6bd6ba09b063c7dafbac2f4`. Original SVGs and the complete Apache 2.0 license (including appendix) remain unmodified in `vendor/material-symbols`. Acquisition records explicitly distinguish five historical digest matches from 49 fresh pinned acquisitions. Fresh metadata preserves duplicate row identities and font-codepoint differences; it does not claim to be the historical snapshot or the metadata that produced that SVG commit. Raw evidence is retained for offline provenance, never bundled or parsed at runtime. Historical paths inside documentary evidence are not build dependencies.

`manifest.json` (schema 2) retains all 36 concepts, 58 contextual Android bindings, 54 variants, 50 exact SF literals and the accepted decisions D01 to D10. Per-binding fill basis, decision, spec references and accessibility (label, value, role) come from the three sealed archived construction records in `semantics-evidence/`. The generator checks their bytes and never parses them; the tests replay them as an independent oracle for the manifest. Labels and values are documentation for localized owners, never ImageVector or Image content. Route invokers, badges, menu actions and switch rows keep their separate semantics. SF artwork remains system-provided, not Google-licensed art.

Only Back and Send auto-mirror; callers must not flip them again. Conversion uses exact rational decimal arithmetic through relative expansion and the (0,+960) translation, then finite IEEE 754 binary32 literals. `generated-report.json` records the maximum rounding error per asset. One NonZero compound path preserves contours and holes. No runtime parser, eager vector inventory, prewarming or production migration.

Outputs: `ConclaveIcons.kt`, `NativeIconCatalog.kt` and `NativeConvertedIconFixtures.kt` in `apps/conclave-skip/Sources/Conclave/Skip/ui/icons`; `ConclaveSymbols.swift` and `NativeSymbolCatalog.swift` in `apps/conclave-skip/Sources/Conclave/DesignSystem/iOS/Icons`; the full license as `MaterialSymbols-LICENSE.txt` in the iOS module resources (which Skip also maps into the Android module assets) and in the Android app assets. Final archive inspection and native pixel/runtime acceptance remain separate gates.
