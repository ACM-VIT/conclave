# Conclave Native (`apps/conclave-skip`) - Polish & Performance Handoff

**Author:** prior agent session (2026-07-01)
**Audience:** the next agent picking up native polish + performance
**Mission:** finish the Lottie meeting-entry overlay, fix the outstanding correctness bugs, and make the whole Android app **buttery smooth** (it currently feels laggy/sluggish - join screen, sheets, in-meeting). iOS should stay green throughout.

> Read this top-to-bottom once before touching code. Sections 2–3 will save you hours; the bugs in §4 and the perf model in §5 are the actual work.

---

## 0. TL;DR - do these in order

1. **P0 - Entry overlay reveal is not proven.** The branded Lottie+audio takeover (`isEnteringMeeting`) is wired but was observed **stuck black over a fully-joined meeting** once, and in a clean retest the New-meeting tap didn't start a join. Make the reveal/safety-timeout bulletproof and verify end-to-end. (§4.1)
2. **P0 - Lottie renders black on Android.** lottie-compose shows nothing (black) where the Conclave lockup should animate. Cosmetic but makes the overlay + any branded screen look broken. (§4.2)
3. **P0 - Confirm the onChange NPE fix.** Fixed this session (zero-param `onChange`); no crash seen after, but not yet confirmed through a full meeting entry. (§4.3)
4. **P1 - Performance.** The sluggishness is **recomposition-bound**. Split large `@Observable`-reading bodies, isolate high-frequency state, lighten sheets. This is the headline ask. (§5)
5. Keep both platforms green (`swift build` + `gradle :app:assembleRelease`) and `swift test` passing. (§2, §7)

---

## 1. What this app is

- **Skip framework** app: Swift is the single source of truth, transpiled to **Kotlin/Compose for Android** and compiled natively for **iOS**. Source lives in `Sources/Conclave/**`.
- `#if SKIP` blocks → Android-only (Kotlin). `#else` / non-SKIP → iOS. Hand-written Kotlin lives in `Sources/Conclave/Skip/*.kt` (package `conclave.module`), bridged from Swift via `ComposeView { _ in SomeComposable() }`.
- It is the native twin of the web app in `apps/web`. **The web app is the design/behavior reference** - when in doubt, match it. Web meeting-entry reference: `apps/web/src/app/components/MeetingEnterOverlay.tsx`, `ConclaveLottie.tsx`, `lib/conclaveSound.ts`.
- **Hard design law: NO GRADIENTS anywhere.** Flat solid surfaces + 1px borders + a single coral accent (`ACMColors.primaryOrange`, ~`rgb(249,95,74)`). The web app has zero gradients; native must match. Dark theme only.
- Media stack: mediasoup (`com.mediasfu:mediasoup-client` on Android) over a socket relay to an SFU. Guest identity is supported (the "G" avatar / "Guest").

---

## 2. Environment · build · install · test

Primary dir: `apps/conclave-skip`. Android Gradle project: `apps/conclave-skip/Android` (uses the **system** `gradle` at `/opt/homebrew/bin/gradle` - there is **no** `./gradlew` wrapper).

```bash
# ---- iOS / macOS host build (fast Swift-level gate; also runs as the Android prebuild) ----
cd apps/conclave-skip
swift build                       # must end "Build complete!"
swift test                        # keep green

# ---- Android: fast Kotlin compile gate for the library (catches transpile/overload errors) ----
cd apps/conclave-skip/Android
gradle :Conclave:compileDebugKotlin

# ---- Android: release APK you install on device ----
cd apps/conclave-skip/Android
ALLOW_DEBUG_RELEASE_SIGNING=true gradle :app:assembleRelease
#   -> APK: apps/conclave-skip/.build/Android/app/outputs/apk/release/app-release.apk
#      (NOTE the non-standard path under .build/Android, NOT app/build/outputs)

# ---- Install (debug-signed release == same signature, so -r works without uninstall) ----
adb install -r apps/conclave-skip/.build/Android/app/outputs/apk/release/app-release.apk
```

- The Android build's `settings.gradle.kts:19` runs `skip plugin --prebuild && swift build --scratch-path .build/index-build` (a macOS host transpile). If it fails, run `swift build` directly to see the real error.
- `ALLOW_DEBUG_RELEASE_SIGNING=true` is required locally (no `keystore.properties`); it signs release with the debug key. Fine for on-device testing.
- App id: **`com.acmvit.conclave`**, launcher activity **`conclave.module.MainActivity`**.
- **Don't** pipe `swift build`/`gradle` through `tail`/`grep` in a way that masks the exit code when you need pass/fail - read the tail but trust the exit status.
- Transpiled Kotlin (for reading what your Swift became) lives under:
  `.build/plugins/outputs/conclave-skip/Conclave/destination/skipstone/Conclave/src/main/kotlin/conclave/module/*.kt`

### Release build config is deliberately un-minified (do not "fix" this)
`Android/app/build.gradle.kts` release buildType: `isMinifyEnabled=false`, `isShrinkResources=false`, `isDebuggable=false`. **R8 breaks SkipUI** two ways:
- onChange NPE - R8 strips a null-check path (worked around with `-assumenosideeffects checkNotNullParameter` in `proguard-rules.pro`, now inactive since minify is off).
- Preference NPE - `Preference.getReduced()` on null in SkipUI's `PresentationRoot` (crashed "Invite people" share sheet); `-dontoptimize` did **not** fix it.

Non-minified avoids **both** R8 crashes. The tradeoff: `checkNotNullParameter` is present at runtime, so any SkipUI null it would have stripped now throws (see §4.3). APK is ~200 MB - that's expected for the un-minified local artifact.

---

## 3. Gotchas that will bite you

### Skip transpile (Swift that won't become valid Kotlin)
- `Array(someString)` unsupported; `String.append(Character)` → use `+=`; `String.removeLast()` → `dropLast()`.
- Overflow ops `&+=` invalid. `Double? ?? 0` → `?? 0.0`. `.padding(.top, cond ? 2 : 10)` → `2.0 : 10.0`.
- `let object = …` - `object` is a Kotlin keyword; rename.
- Method references `.compactMap(Self.fn)` → use an explicit closure.
- `UInt64` literals: `let x = UInt64(700_000_000)`, **not** `let x: UInt64 = 700_000_000`.
- Capturing `self?.foo ?? 12_000_000_000` inside a `Task` can produce a `ULong ?: Long` mismatch - capture the value into a `let` **before** the `Task`.
- Comparing `UInt64(someDouble)` to a `UInt64` constant → `Comparable<*>` mismatch; do the math in `Double` seconds instead.
- `Character.isLetter` and tuples with >5 elements are unsupported.
- `canImport(Lottie)` is **unreliable** - true on the macOS transpile host even when the framework isn't linked. Gate iOS-only deps on **`#if os(iOS)`** instead (this is why `ConclaveLottieView.swift` uses `os(iOS)`).
- Material icons need explicit imports on the Kotlin side.
- `R.raw` doesn't resolve cross-module from `:Conclave`. Android runtime assets go in `Android/app/src/main/assets/` and load via app context; iOS uses `Bundle.module` (`Sources/Conclave/Resources/`). The Lottie + lock sound are duplicated in both places on purpose.

### SkipUI `onChange` null crash (important - you'll re-hit this)
SkipUI backs `.onChange` with `rememberSaveable` (see `.build/checkouts/skip-ui/Sources/SkipUI/SkipUI/View/AdditionalViewModifiers.swift:755-812`). Under recomposition/state-restoration churn the **two-parameter** form `{ old, new in }` can be invoked with a **null `oldValue`**, and Kotlin's `checkNotNullParameter` throws:
```
java.lang.NullPointerException: Parameter specified as non-null is null:
  method conclave.module.MeetingView.body$lambda$…, parameter <unused var>
```
**Fix pattern:** if the handler ignores its params, use the **zero-parameter** overload `.onChange(of: value) { … }` (SkipUI overload at `AdditionalViewModifiers.swift:785`, `of value: V?`). No lambda param ⇒ nothing to null-check. Already applied to `MeetingView.swift` (4 handlers) and `ContentView.swift` (2 handlers) this session. **Any remaining `#if SKIP` two-param `{ _, _ in }` onChange that fires during high-churn moments is a latent crash** - prefer zero-param whenever the body doesn't read old/new. (There are ~35 two-param onChange sites app-wide; most are fine because they fire on discrete user actions, but audit ones on the entry/connection path.)

### adb / device testing
- Samsung device auto-locks (keyguard/AOD). Before testing: `adb shell svc power stayon true`, `adb shell wm dismiss-keyguard`, wake with `input keyevent KEYCODE_WAKEUP`.
- The test device is **noisy** - WhatsApp/notifications/home-screen widgets steal foreground. Verify you're actually looking at the app: `adb shell dumpsys activity activities | grep -i ResumedActivity`.
- **`uiautomator dump /dev/tty` collides** if a stale UiAutomation session exists ("UiAutomationService … already registered!" - that FATAL is uiautomator's own process, **not** the app). Dump to a file instead: `adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml`. It's the most reliable way to read the Compose UI (screenshots can lie - see §4.2).
- **App logs are NO-OP on Android** (`Sources/Conclave/Shared/Logging.swift` compiles to nothing under SKIP). You cannot `Log.debug` your way through this. To trace, either (a) read the UI tree via uiautomator dump (content-desc/text), (b) watch the ComposeView draw cadence in logcat (`I View: setRequestedFrameRate …` spam = something animating at 60fps), or (c) **add a temporary on-screen debug affordance** (e.g. render `connectionState`/`isEnteringMeeting` as visible text) while diagnosing.
- Filter logcat to the app: `PID=$(adb shell pidof com.acmvit.conclave); adb logcat -d | grep " $PID "`. Ignore `NearbyConnections`, `ChargingInfoManager`, `setRequestedFrameRate` noise.
- To reset cleanly: `adb shell am force-stop com.acmvit.conclave` (also kills the background-call foreground service that otherwise keeps a meeting alive), then relaunch.

---

## 4. P0 - Correctness bugs

### 4.1 - Entry overlay never reveals / can stick black over a joined meeting  ⚠️ TOP PRIORITY
**What the feature is:** on New/Join, show a full-screen branded takeover (`MeetingEntryOverlayView`: `Color.black` + `ConclaveLottieView` + low caption + lock sound) that stays up until the meeting is *fully ready*, then fades to reveal a settled meeting - hiding the post-join device-init hiccups. Mirrors web `MeetingEnterOverlay`.

**Observed failure (high confidence):** after entering, the screen stayed **pure black while the meeting was fully joined underneath** - a uiautomator dump showed live meeting controls (`Hang Up`, `Participants, 1`, `Unmute microphone`, `Turn camera on`, self-tile `You`, room `poppy-peony-akira`) under the black overlay, and the ComposeView was redrawing at ~60fps (the Lottie). i.e. `isEnteringMeeting` was still `true` (or `connectionState` stuck at `.joining`) long after the meeting was usable, and **neither the reveal task nor the 12 s safety timeout cleared it.**

**Second observation (medium confidence):** in a *clean* retest, tapping the coral "New meeting" produced **no join at all** (no socket/SFU activity in logcat, UI stayed on JoinView). Either the tap missed, or the **guest New-meeting path needs a name / has a gate**. Verify this path works before blaming the overlay.

**Where the logic lives:**
- State: `Core/State/MeetingState.swift` - `isEnteringMeeting: Bool`, `meetingEntryAction: MeetingEntryAction?`, `enum MeetingEntryAction { case new; case join }`.
- ViewModel: `Features/Meeting/MeetingViewModel.swift` - constants `meetingEntryMinDisplaySeconds = 1.3`, `meetingEntrySettleNanoseconds = 700_000_000`, `meetingEntrySafetyTimeoutNanoseconds = 12_000_000_000`, tasks `meetingEntryRevealTask` / `meetingEntrySafetyTask`, and methods **`beginMeetingEntry(action:)`**, **`scheduleMeetingEntryReveal()`**, **`clearMeetingEntry()`**. `scheduleMeetingEntryReveal()` is called right after `state.connectionState = ConnectionState.joined` (in `handleJoinedRoomResponse`, ~after `resetReconnectRetryState()`).
- Trigger: `Features/Join/JoinView.swift` - `beginMeetingEntry(action: .new)` in `handleCreateMeeting`, `beginMeetingEntry(action: .join)` in `handleJoinRoom` (both right before `joinRoom(...)`).
- Overlay wiring: `App/ContentView.swift` - `.overlay { Group { if isEnteringMeeting && isEnteringMeetingConnectionState { MeetingEntryOverlayView(...) .transition(.opacity) } } .animation(…, value: isEnteringMeeting) }`. `isEnteringMeetingConnectionState` is true for `.connecting/.connected/.joining/.joined`.

**Why it probably sticks - investigate in this order:**
1. **The reveal is time-task-based and fragile.** `scheduleMeetingEntryReveal()` does `Task.sleep(settle)` then min-display then `clearMeetingEntry()`. If that `Task` is cancelled by view churn, or `handleJoinedRoomResponse` doesn't actually run on this path (guest flow?), it never clears. The **safety task** in `beginMeetingEntry` is the backstop - confirm it's actually scheduled and **not cancellable by the same churn** (store it so only `clearMeetingEntry()` cancels it; use `Task.detached` or a `@MainActor` timer that survives recomposition; `try? await Task.sleep` swallows cancellation silently, so a cancelled safety task fails *invisibly*).
2. **Never reaches `.joined`.** If the SFU handshake stalls at `.joining`, the reveal (which only fires on `.joined`) never runs - so the safety timeout MUST win. Verify by rendering `connectionState` on-screen temporarily.
3. **State write not observed.** Confirm `state.isEnteringMeeting = false` actually recomposes `ContentView` (it's `@Observable`; make sure the overlay condition reads `meetingViewModel.state.isEnteringMeeting` directly, which it does).

**Recommended hardening:**
- Make overlay visibility a **pure function of observable state**, not solely a fire-and-forget task. e.g. keep the task for the *nice* min-display timing, but also compute a hard ceiling: stamp `meetingEntryStartedAt`; in the overlay condition (or a cheap computed prop) hide once `now - startedAt > safetyCeiling`. That way even if every task dies, the overlay self-dismisses.
- Reveal on **any** terminal entry state: `.joined` (settled), `.waiting` (yield to `WaitingRoomView`), `.error` (show branded error then `JoinView`), `.disconnected`. Today `.error`/`.waiting` rely on `isEnteringMeetingConnectionState` returning false - double check `clearMeetingEntry()` is also called on those transitions so the flag doesn't linger.
- Ensure `clearMeetingEntry()` fully **removes** the overlay (so the Lottie stops invalidating - see §5), not merely hides it.

**Verify:** clean cold start → New meeting → overlay appears with caption + sound → holds through connect/join → **fades within ~1.3–2 s of ready** to a stable meeting (self-tile + controls on first paint, no camera/mic flip, no re-layout). Repeat for Join-by-code, a **bad** code (branded error → back to setup), and a **locked** room (yields to WaitingRoomView). Nothing should ever sit on black > ~12 s.

### 4.2 - Lottie renders black on Android
The Conclave lockup animation shows as **solid black** on Android (seen in the entry overlay and the stuck state). The composable is `Sources/Conclave/Skip/ConclaveLottie.kt` (`ConclaveLottieComposable`) using `rememberLottieComposition(LottieCompositionSpec.Asset("conclave-animation.lottie"))` + `LottieAnimation(iterations = IterateForever, speed = 3f)`; bridged from `ConclaveLottieView.swift`. Asset: `Android/app/src/main/assets/conclave-animation.lottie` (dotLottie, ~1.27 MB).

**Suspects:** (a) the `.lottie` (dotLottie zip) asset path/format not decoded by lottie-compose `Asset(...)` at runtime (try the **raw JSON** extracted from the dotLottie instead, or confirm `com.airbnb.android:lottie-compose:6.4.0` handles dotLottie); (b) composition failing to load → `LottieAnimation` draws nothing over `Color.black`; (c) the animation is light-on-transparent and the layer under it is black so it *reads* black - unlikely given the web renders it fine. Add a temporary tint/placeholder to distinguish "not loading" from "loading but invisible". Confirm the asset is actually packaged in the APK (`unzip -l app-release.apk | grep lottie`). iOS side uses lottie-ios `DotLottieFile.named("conclave-animation", bundle: .module)` - verify iOS renders (if iOS is fine, it's an Android asset/decoder issue).

### 4.3 - Confirm the onChange NPE fix (likely done)
This session converted the four `#if SKIP` `onChange` handlers in `MeetingView.swift` (~line 324) and the two in `ContentView.swift` (~line 73/76) from two-param `{ _, _ in }` to the **zero-param** form (see §3). Rebuilt + installed; **no `checkNotNullParameter` FATAL observed afterward** and JoinView renders cleanly. **Not yet confirmed through a full, successful meeting entry** (the clean retest didn't start a join). Confirm no NPE across: enter meeting, open/close chat, open/close the More sheet, open transcript, toggle webinar. If it recurs elsewhere, apply the same zero-param conversion at that site.

### 4.4 - (verify) Guest "New meeting" path
In the clean retest the coral **New meeting** tap didn't create a room (no network). Confirm the guest path (`handleCreateMeeting` with empty name → defaults to "Guest") actually fires `joinRoom`. If it requires a name, that's a UX gate to surface (disable button / hint), not silently no-op.

---

## 5. P1 - Performance ("make it buttery")

**Root cause:** the sluggishness is **over-broad recomposition**, not CPU-bound work. SkipUI maps each SwiftUI `View.body` to a Compose function. Reading any property of a big `@Observable` (esp. `MeetingViewModel.shared` / `state`) inside a large `body` means **the entire body recomposes whenever *any* read property changes**. High-frequency state (active speaker, audio levels, stats, participant deltas) then thrashes huge subtrees. Sheets feel worst because their content rebuilds on every parent recomposition and the presentation animates a heavy tree.

Work the following, measuring before/after with the Compose draw cadence (`adb logcat | grep setRequestedFrameRate` should be quiet when idle) and simple on-device feel:

1. **Split large bodies into small leaf views.** Priorities: `MeetingView`, `JoinView`, the sheets (`MeetingSheetView`, `MoreSheetView`, `SettingsSheetView`, `ParticipantsSheetView`), `ControlsBarView`, `ChatViews`. Each leaf should read **only** the narrow slice of state it needs. Pass **primitives** (e.g. `isMuted: Bool`) into subviews rather than the whole `viewModel`, so a change to unrelated state doesn't recompose them.
2. **Isolate high-frequency state.** Active-speaker, audio level, connection quality, and stats updates must live in their own tiny views. Never read them in a top-level `body`. Continue/extend the existing throttle (`isStageObscuredByOverlay` + `activeSpeakerObscuredTickInterval`) - when the stage is covered by a sheet/overlay, stop polling entirely.
3. **Lighten sheets.** Build sheet content lazily; avoid recomputing lists/sorts on every recomposition; memoize derived data (sorted participants, formatted names/times) in the view model, not in `body`. Confirm sheets aren't re-instantiated heavy children each frame. (There's a known Skip quirk: presenting a sheet from a dismissing sheet renders empty - defer via `onDismiss`; see the `skip-compose-ui-gotchas` note.)
4. **Kill animation/redraw churn.** Audit broad `.animation(value:)` modifiers on large containers - they animate the whole subtree. The entry-overlay animation was **scoped to the overlay layer** this session (was on the whole `ContentView`); look for other broad ones. Ensure the entry Lottie is **removed** (not just hidden) after reveal so it stops invalidating at 60fps (§4.1).
5. **ComposeView bridges** (e.g. `CameraPreview`, `ConclaveLottie`): make sure they aren't recreated on every recomposition (stable keys / hoisted state). Recreating the mediasoup/camera surface is expensive.
6. **Avoid work in `body`.** Move formatting, filtering, sorting, and any allocation out of `body` into cached/computed state updated on change.
7. **Icons/tint:** ComposeView icons need explicit tint on Android (see `skip-compose-ui-gotchas`); missing tint can cause re-layout surprises.

Suggested measurement loop: pick one surface (start with **the sheets** - user called them out as "especially" laggy), instrument the draw cadence, refactor to narrow reads, re-measure, repeat. Don't micro-optimize before you've split the bodies - that's where the wins are.

---

## 6. P2 - Polish / parity remainder

- Entry sound (`Sources/Conclave/Shared/EntrySound.swift` + `Skip/EntrySoundBridge.kt`, `conclave-lock.mp3`): confirm it plays once on overlay appear on a real device (best-effort; must not disturb the call `AVAudioSession` on iOS).
- Keep verifying **no gradients** crept in (hard rule).
- Native parity phases 1–6 (privacy policy, connection-quality banners, GIF picker, game catalog cards, Wordle, transcription) are implemented and compile - **smoke-test each on a real device**; they were never fully device-validated.
- Chat was redesigned to a docked flat panel (matching web) - verify it still reads well after any perf refactor.

---

## 7. Verification checklist (before declaring done)

- [ ] `swift build` → "Build complete!"
- [ ] `swift test` green
- [ ] `gradle :app:assembleRelease` (with `ALLOW_DEBUG_RELEASE_SIGNING=true`) → BUILD SUCCESSFUL
- [ ] Install, cold start → **JoinView renders** (flat, coral accent, prejoin mic+camera OFF), no black screen
- [ ] New meeting (guest) → overlay (Lottie **visible** + sound) → **reveals a settled meeting < ~2 s after ready**, no device-init hiccup, no crash
- [ ] Join by code, bad code (branded error → setup), locked room (→ WaitingRoomView)
- [ ] Open/close chat, More sheet, transcript, settings - no NPE, and **sheets feel smooth**
- [ ] Idle in-meeting: ComposeView draw cadence is quiet (`setRequestedFrameRate` not spamming) except intended animations
- [ ] "Invite people"/share sheet opens (no Preference NPE)
- [ ] No gradients anywhere

---

## 8. Key files index

| Concern | File |
|---|---|
| App root / routing / entry overlay wiring | `Sources/Conclave/App/ContentView.swift` |
| App entry | `Sources/Conclave/App/ConclaveApp.swift` |
| Entry state + `MeetingEntryAction` | `Sources/Conclave/Core/State/MeetingState.swift` |
| Entry begin/reveal/clear + constants | `Sources/Conclave/Features/Meeting/MeetingViewModel.swift` |
| Entry overlay view | `Sources/Conclave/Features/Meeting/MeetingEntryOverlayView.swift` |
| Lottie view (iOS+Android) | `Sources/Conclave/Features/Meeting/ConclaveLottieView.swift` |
| Lottie Android composable | `Sources/Conclave/Skip/ConclaveLottie.kt` |
| Entry sound | `Sources/Conclave/Shared/EntrySound.swift`, `Sources/Conclave/Skip/EntrySoundBridge.kt` |
| New/Join triggers | `Sources/Conclave/Features/Join/JoinView.swift` |
| Meeting UI (onChange, stage-obscured) | `Sources/Conclave/Features/Meeting/MeetingView.swift` |
| Sheets (perf targets) | `Features/Meeting/{MeetingSheetView,MoreSheetView,SettingsSheetView,ParticipantsSheetView}.swift` |
| Controls / chat | `Features/Meeting/{ControlsBarView,ChatViews}.swift` |
| Release build config | `Android/app/build.gradle.kts` (release buildType) |
| ProGuard (inactive) | `Android/app/proguard-rules.pro` |
| Android runtime assets | `Android/app/src/main/assets/` |
| iOS bundle resources | `Sources/Conclave/Resources/` |
| SkipUI onChange source (reference) | `.build/checkouts/skip-ui/Sources/SkipUI/SkipUI/View/AdditionalViewModifiers.swift` |

## 9. State of the working tree (as of handoff)

Branch `staging`. Uncommitted work spans the entry overlay + parity phases + this session's onChange/animation fixes. Notable **modified**: `ContentView.swift`, `MeetingView.swift`, `MeetingViewModel.swift`, `MeetingState.swift`, `JoinView.swift`, `build.gradle.kts`, `proguard-rules.pro`, several meeting views, `Skip/ScreenIcons.kt`, tests. Notable **untracked** (parity work): `KlipyService.swift`, `TranscriptService.swift`, `TranscriptWebSocket.swift`, `TranscriptState.swift`, `GifPickerView.swift`, `TranscriptPanelView.swift`, `WordleGameView.swift`, `PrivacyPolicyView.swift`, `TranscriptWebSocketBridge.kt`, plus the entry-overlay files above. **Nothing has been committed for this work** - do a focused review/commit once P0 is verified. Don't commit or push unless asked.

> Plan file for the entry overlay specifically: `~/.claude/plans/bubbly-pondering-crystal.md`.
