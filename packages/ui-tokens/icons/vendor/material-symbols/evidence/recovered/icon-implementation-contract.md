# Remaining WP1 icon implementation contract

Reconstructed selection and implementation requirements; no generator/native code was implemented here. The full former parent [implementation brief](recovered-text/icon-parent-implementation-plan.md) survives as a creation-event body. The complete [manifest brief](recovered-text/icon-manifest-implementation-brief.md) and [selection disposition](recovered-text/icon-selection-disposition.md) were extracted and their text digests match historical recorded pins; this does not restore their missing input/reference directories or certify the complete final plan. [I5-I9](sources-index.md#i5).

## Preconditions and scope

Parent must finish/disposition feedback/panel runtime and return source ownership. Preserve freeze293 and R1/L1/F1/L2, stage identity, feedback counters, panel coordinator and all fixture controls. Re-read the current accepted API before integration. The new 17e portrait results do not close compact filled keyboard or Duo iOS 27.1, and this report does not decide whether those residual limits permit the next slice.

Before a reproducible implementation: locate or deliberately re-establish missing selected SVG bytes, license/provenance and reference package in durable storage under a separately assigned parent lane. This task did not download, recreate or render them. Historical hashes are comparison anchors, not present files. No fallback to current CDN/another family or old `ScreenIcons` aliases.

## Accepted selection

Exactly **36 concepts / 48 Material names / 54 Android variants / 58 contextual bindings / 50 SF literals**. Full [mapping table](icon-selection.md) and [reconstructed selection JSON](icon-selection.reconstructed.json). The JSON is deliberately not the original 208,477-byte provenance manifest. It recovers all finite choices and SF literals from complete readback plus final context patches; only ten complete records from the 96-input index survive in the inspected prefix. Payloads for all SVGs remain absent. Per-binding accessibility objects and provenance fields not reconstructed remain available as archived construction/patch text, not fabricated values. [I1-I4](sources-index.md#i1), [I11](sources-index.md#i11).

- D01: one fill0 for unspecified ordinary action/route/decoration/status; no automatic cross product.
- D02-D04: group0 closed / group1 open; present_to_all0 idle / present_to_all1 presenting badge / cancel_presentation1 sharing toggle and separate Stop sharing action; keep0 Pin / keep_off0 Unpin / keep1 pinned badge.
- D05-D06: lock1 locked, lock_open0 unlocked; warning1/error1/info0 next to explanatory text.
- D07: only arrow_back.fill0 and send.fill1 autoMirror. All other 52 are false; no caller double flip.
- D08: F00 exact common-control names and sentence-case labels win over conflicting feature snippets. Distinct SF menu/badge literals are retained, not generic suffix expansion.
- D09: all 50 have historical local Apple catalog evidence by iOS 17. Extra mic.slash/video.slash/pin.fill map to 13.0; rectangle.inset.filled.on.rectangle to 15.0. Device symbol lookup/rendering and API guards remain unproved.
- D10: lazy inert gallery after panel disposition; adaptive inspector/stage extension is separate and uses the same coordinator.

Canonical route glyph is `bluetooth` from Google commit `49d4db35df873165d6bd6ba09b063c7dafbac2f4`. Both historical bluetooth fills were 459 bytes with SHA `3736a6c4fb26629b36b2ca6e2f28e5a61a72a4419c1ad18bfcf66bac4490e2de`; selected output is fill0. `bluetooth_audio` is quarantined because successful HTTP/hash checks did not establish Rounded-family eligibility. Preserve duplicate metadata rows by identity. Historical total 96 pairs/48 names/52,263 bytes/87 payload hashes is an input superset; 42 pairs were unselected. [I12](sources-index.md#i12).

## Accessibility and platform ownership

Artwork never owns labels. A labeled Android control passes null child contentDescription; the iOS child image is hidden to accessibility. Localized owner supplies label/value/role and disabled/busy/selection semantics; no raw glyph IDs. Status badges merge with adjacent row/tile text. Standalone meaningful images require explicit localized copy.

Mic values On/Muted; camera On/Off; hand Raised/Not raised (iOS lowered value absent); captions On/Off; Reactions Closed/Open. Sharing toggle remains Share screen + Sharing value; the separate Stop sharing button has its own label and no value. Host badge and Host controls action are separate bindings. Search decoration and Search action are separate bindings. Host-menu Lock uses Checkbox; Switch rows retain Switch. Route rows use their route names and RadioButton selection, while Audio output invoker is Button. Context labels such as Close {title}, Back to call, Admit {name}, Send question and Clear search stay caller-owned. [I3](sources-index.md#i3), [I4](sources-index.md#i4).

iOS constants are exact native-only immutable static strings, no shared runtime icon enum. Back and AVRoutePickerView remain system-owned; Close has xmark plus availability-guarded system role. Default monochrome; iOS 26 flat-rendering/Close APIs retain iOS 17 paths. Android uses one internal namespace with thread-safe lazy per-variant ImageVector accessors; stable identity, no eager all-icons vector list, startup prewarm or runtime SVG/JSON parser. Typography/context chooses 18/20/24 dp; source stays 24 dp with 960x960 viewport.

## Converter requirements (complete recovered section)

The following describes the former inspected input set. Its artwork bytes are absent now; this recovery did not inspect SVG payloads or run the converter.


The inspected **96** SVGs all have SVG namespace, `width="24"`, `height="24"`, `viewBox="0 -960 960 960"`, one direct `<path d="…">`, and no other content/attributes. Actual letters: **M m L l H h v Q q T t Z**; 42 files have implicit parameter repetitions. The bounded converter profile supports both cases of **M/L/H/V/Q/T/Z**, including V/z even though absent here. Do not generalize from their absence or silently treat an unsupported command as a line.

1. Parse XML with DTD/entity/network resolution disabled. Reject DTDs, entities, processing instructions, comments/CDATA, additional namespaces/attributes, text, child elements, groups, transforms, CSS, explicit paints, stroke, clipping, gradients, resources and references. For this profile accept only the exact observed dimensions and path structure. A different viewport or SVG feature requires an explicit profile amendment, never automatic repair.
2. Tokenize full path grammar: signed integers/decimals, leading-dot decimals, adjacent signs, allowed whitespace/comma separators, optional finite decimal exponents; reject leftovers, doubled/misplaced commas, NaN/infinity, incomplete groups and arguments after close. Resource bounds are proposed as 128 KiB per SVG, 128 characters per numeric token and 10,000 expanded segments; fail excess rather than truncate. Every path starts with M/m. Command arities are 2,2,1,1,4,2,0 respectively.
3. Interpret in **source coordinates** with current point `(0,0)`, subpath start, previous segment kind and last quadratic control. Expand every implicit repeat. First M/m pair starts a subpath; subsequent pairs are L/l, with each relative pair based on the updated current point. Relative h/v affect only the specified axis; H/V become explicit line endpoints. Preserve zero-length segments and repeated points.
4. Q/q consumes one control and endpoint, both relative to the segment's starting point for q. T/t reflects the immediately preceding Q/q/T/t control around the current point; otherwise its control is the current point. Repeated T groups reflect the control produced by the preceding group. M/L/H/V/Z reset quadratic reflection. Z/z emits close, moves current point to the subpath start, and resets reflection; a subsequent relative m is relative to that restored point. Preserve subpath ordering, directions and closures.
5. **Then** translate every absolute endpoint and quadratic control by **`(0,+960)`** into a 960×960 zero-origin viewport. No Y flip, scale-to-24 coordinate rewrite or delta translation. If an implementation retains relative operations, only absolute positions get the offset; first relative moveto must still start from the correctly translated origin. Prefer normalized absolute M/L/Q/Z operations to make this auditable.
6. Emit native `moveTo`, `lineTo`, `quadTo` and `close` operations, maintaining one compound path with **NonZero** winding. SVG defaults here are black fill/no stroke; output uses a solid neutral fill and caller tint. Preserve holes and self-overlap behavior; do not reverse contours, merge subpaths, simplify curves, deduplicate commands, switch to EvenOdd or independently fill each contour. Default dimensions 24 dp; viewport 960×960. Coordinate normalization is an interpreted operation stream, **not copying `d` into a string or prepending an offset**.

No converter was implemented in this lane. XML/lexical checks in validation establish input structure, not normalization, smooth-reflection correctness, winding or native appearance.

## Deterministic generation and owned paths

Build-time manifest, selected inputs/license/provenance, offline generator and focused checks belong under `packages/ui-tokens`; Android output `Sources/Conclave/Skip/ui/icons/ConclaveIcons.kt`, native iOS constants under `Sources/Conclave/DesignSystem/iOS`. All permanent references become repository-relative. Parent explicitly allowed a compact schema and deduplicated provenance only if identities/finite choices remain exact. Do not copy temporary paths into builds.

Reject duplicate JSON keys, nonfinite numbers, unknown fields, duplicate/colliding IDs, missing/unused/mismatched input, changed source/provenance/license hashes, wrong axes/family/ineligible metadata rows, undeclared fills, unexplained symbols, invalid semantics, unexpected mirroring, unsupported SVG and path escapes/symlinks before writes. Deterministic UTF8/LF/order/numbers/profile hashes; exact-decimal intermediate arithmetic; reviewed Float32 serialization/error accounting. Stage all outputs before replacement; non-writing --check detects missing/stale/extra outputs. No network, best-effort fallback or placeholders. Semantic fixtures, independent geometry/pixels and output drift are distinct gates. [I6](sources-index.md#i6).

Integrate one opt-in gallery control in current iOS PlatformRoot and Android NativeHostingRows, with separate lazy gallery/controller files. Preserve bootstrap/normal routes/active-call priority. No dependencies, Gradle/Skip/R8/pins, token colors/web exports, legacy icon consumer, media, SFU or apps/mobile changes. Production adoption remains separate.

## Raster controller and finite future matrix

Use actual generated vectors through public `rememberVectorPainter(ImageVector)` in real Debug composition and public `CanvasDrawScope.draw`/Painter.draw with Android Bitmap/Canvas. Constructor/convenience VectorPainter helpers are Kotlin-internal despite JVM-public spelling. Sample remains uncompiled/unapplied; do not use it as a complete controller. Use selected `check.fill0` / `CheckFill0` as a nonmirroring control, not nonexistent logout.fill0. [I9](sources-index.md#i9).

Explicit preview eligibility + debuggable-app guard + Start/Cancel; one run owner; main-thread composition/draw; bounded readiness; disposal AND background cancellation; controlled pixel size/density/layout direction in both composition and offscreen scope. Transparent sRGB ARGB_8888, enabled premultiplication, software canvas, black SrcIn tint. Export privately on IO with exclusive names, bounded memory/time, checked compression, ownership before recycle. Failed readiness/export/cancellation retains captures/reasons and incomplete index, never completion. Write completion last. Parent-owned extraction via run-as; raw direct adb pull cannot assume private sandbox access.

Pixel protocol: top-left row-major straight sRGB RGBA8, RGB=0 where alpha=0; distinguish storage premultiplication from normalized pixels and PNG-file hashes. Prove PNG dimensions and round-trip normalized hashes. Parent accepted Debug reachability guards: helpers may remain in unminified Release, so physical exclusion is not a claim. Normal/Release opt-in rejection stays a runtime gate. [I8](sources-index.md#i8).

Future sequence: four independently specified native geometry fixtures -> actual converter fixture outputs -> readiness/cancellation/export round-trip -> freeze comparison policy -> 54 assets ×18/20/24/48dp ×1x/3x =432 LTR renders; 54 existing72px LTR candidates also compare with independent secondary backend; Back/Send16 native RTL cases plus LTR→RTL→LTR repeatability; 52 nonmirroring72px controls. Exercise native autoMirror, not a post-capture candidate flip. Separately assess winding/holes/interior/connected components/bounds and edge AA. Current historical references supply no calibrated native thresholds; the earlier brief's example tolerances are not accepted numeric pass criteria. Offscreen software is not on-screen/GPU/physical proof. [I9](sources-index.md#i9), [I10](sources-index.md#i10).

Historical 432 primary originals,54 independent renders,16 mirror targets and four semantic fixtures were generated and sealed, but their bytes are lost. Recovered protocol/expectations are documentary evidence only. Never count them as available reference images or silently regenerate and relabel them old evidence.

## Recovered independent fixture checkpoints

The original 72px mathematical checkpoints survive in [I13](sources-index.md#i13). These preserve expected geometry, not the absent SVG/PNG bytes. Pixel bounds exclude right/bottom edges and sample locations are pixel indices. The historical feasibility text contains an earlier logout example; the final review corrects it to check.fill0.

At 72px the existing four fixtures give these fixed geometric checkpoints (pixel bounds are right/bottom exclusive; sample locations are pixel indices):

- Opposite-winding rectangles: source bounds `(160,-800)-(800,-160)` → `(12,12)-(60,60)`; inside `(16,36),(36,16)`, outside `(36,36),(2,2)`; one component/one hole.
- Same-winding nested rectangles: same bounds; inside `(36,36),(16,36)`, outside `(2,2),(65,36)`; one component/no hole. This catches an accidental EvenOdd switch.
- Relative moveto after close: two rectangles `(160,-800)-(320,-640)` and `(480,-480)-(640,-320)` → overall `(12,12)-(48,48)`; inside `(18,18),(42,42)`, outside `(30,30),(42,54),(2,2)`; two components/no hole.
- Smooth quadratic: source Q control `(320,-800)`, endpoint `(480,-480)`; reflected T control `(640,-160)`, endpoint `(800,-480)`. Native translated controls are `(320,160)` and `(640,800)`, endpoints `(480,480)` and `(800,480)`; first y extremum is native `320`. Overall pixel bounds `(12,24)-(60,60)`; inside `(24,30),(48,54)`, outside `(24,20),(48,36),(2,2)`; one component/no hole.

These are inherited fixed hand-derived specimen expectations, not new calibrated native thresholds. No native pixel, topology, compile, minimum-OS or physical-device pass is asserted.


## License, later gates and return

Retain exact full Apache 2.0 license including appendix: historical SHA `58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd`. No substitute SPDX-only notice. Keep original SVG bytes, applicable notices, factual “Material Symbols by Google”, conversion/pin/hash headers and full license in source/distributed artifacts; inspect exact archive paths under build ownership. Do not invent upstream NOTICE or attribute updater/appendix boilerplate as artwork authorship. SF artwork is not Google-licensed vendored art.

After implementation, parent assigns independent source review and the sole sequential native build/package lane. Focused generator/schema/semantic/real-module checks and touched-package lint/typechecks precede final frozen gates. Parent-owned silent runtime then verifies exact candidates, lazy identity, ordinary/Release guard, gallery semantics/theme/large type/RTL, iOS symbol lookup and repaired feedback/panels plus raster matrix. No live microphone/camera/calls/browser/media/audio/haptics is implied. Minimum OS, speech/focus, physical media/haptics, performance and full WP1/release remain open.

Return exact incremental patch, source manifests, all focused/gate statuses, candidate/license/archive paths, preservation receipts and unexecuted limits. No source implementation, build, runtime, reference-image generation or acquisition ran in this recovery.
