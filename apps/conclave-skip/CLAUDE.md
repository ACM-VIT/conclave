# Conclave Skip Native Agent Notes

This directory is the active native app. Do not make new changes in
`apps/mobile`; it is deprecated for this workstream.

`apps/conclave-skip` is a Skip app: Swift is the source of truth, iOS compiles
the Swift directly, and Android is generated/transpiled to Kotlin/Jetpack
Compose with a few hand-written Kotlin bridges in `Sources/Conclave/Skip`.
Every change must be judged on both platforms.

## Current Priorities

The native app was improved specifically around meeting entry, Lottie,
bottom sheets, games, and responsiveness. Continue from those assumptions:

- Native should feel instant. Avoid broad recomposition and heavy view trees.
- Android sheets must use the native `FlexibleBottomSheet` bridge, not a custom
  fake sheet.
- Android Lottie must use LottieFiles `dotlottie-android`, not Airbnb
  `lottie-compose` for `.lottie` playback.
- iOS must stay green with `swift build` and `swift test`.
- No gradients anywhere. Use dark flat surfaces, 1 px borders, and the coral
  accent only.
- Do not re-enable R8/minification. Release builds are intentionally
  un-minified because R8 has broken SkipUI runtime behavior.

## Build And Verification Commands

Run these from `/Users/ishaan/Projects/conclave` unless noted.

```bash
cd apps/conclave-skip
swift build
swift test
```

Android uses the system Gradle binary, not a wrapper:

```bash
cd apps/conclave-skip/Android
/opt/homebrew/bin/gradle :Conclave:compileDebugKotlin --console=plain
ALLOW_DEBUG_RELEASE_SIGNING=true /opt/homebrew/bin/gradle :app:assembleRelease --console=plain
```

The local release APK is written to:

```text
apps/conclave-skip/.build/Android/app/outputs/apk/release/app-release.apk
```

For iOS simulator builds, the Skip project may need plugin validation skipped
and Skip actions disabled during Xcode build:

```bash
xcodebuild \
  -project apps/conclave-skip/Darwin/Conclave.xcodeproj \
  -scheme "Conclave App" \
  -configuration Debug \
  -destination 'id=<SIMULATOR_UDID>' \
  -derivedDataPath /tmp/conclave-ios-dd \
  -skipPackagePluginValidation \
  -skipMacroValidation \
  build SKIP_ZERO=1 SKIP_ACTION=none
```

Install and open with `agent-device` when a simulator is available:

```bash
agent-device install com.acmvit.conclave /tmp/conclave-ios-dd/Build/Products/Debug-iphonesimulator/Conclave.app --platform ios --udid <SIMULATOR_UDID>
agent-device open com.acmvit.conclave --platform ios --udid <SIMULATOR_UDID>
```

Debug **simulator** builds default the SFU join endpoint to
`http://127.0.0.1:3000` (local dev stack); a guest join fails with the branded
"Could not connect to the server" screen unless a local stack is running. To
smoke against production instead, launch with the env override:

```bash
xcrun simctl terminate <SIMULATOR_UDID> com.acmvit.conclave
SIMCTL_CHILD_SFU_JOIN_URL="https://conclave.acmvit.in/api/sfu/join" \
  xcrun simctl launch <SIMULATOR_UDID> com.acmvit.conclave
```

(Resolution order lives in `SfuJoinService.joinURL()`: env override → bundled
config → 127.0.0.1 on sim / production on device. Debug on a real device and
all Release builds already point at production.)

`agent-device snapshot` + `click @ref` (accessibility refs) is the reliable
way to drive the app on simulator - prefer it over coordinate taps. Sim smoke
of the core loop (guest create → entry overlay with animating Lottie →
settled meeting → chat/sheet → hang up) passed against production on
2026-07-07.

One more transpile gotcha proven here: `.map(String.init)` (any
`map`/`compactMap` with an initializer or function reference) transpiles to
Kotlin `map(String)` - passing the companion object - and fails
`compileReleaseKotlin`. Always use an explicit closure: `.map { String($0) }`.
This shipped in the chess commits and broke the Android build while iOS stayed
green; Android compile is part of "done" for every commit.

Real Android proof still matters for completion:

```bash
adb devices -l
adb install -r apps/conclave-skip/.build/Android/app/outputs/apk/release/app-release.apk
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml /tmp/conclave-ui.xml
```

Do not use `uiautomator dump /dev/tty`; it can collide with stale
UiAutomation sessions. Dump to a file and pull it.

Do not run two Gradle invocations on this project concurrently (e.g. a
background `:app:assembleRelease` while a foreground `:Conclave:compileDebugKotlin`
or an Xcode build runs). The skip prebuild and shared `.build` outputs
collide and the build fails spuriously ("N actionable tasks: 1 executed" with
no error lines). Re-run sequentially before diagnosing anything.

Prod rate-limits rapid room creation per client: after ~a dozen creates in
one session the app path returns "Join request failed" for a while. Space out
sim smoke runs or reuse one room instead of creating fresh rooms per test.

## Performance Learnings

The app felt sluggish mostly because of over-broad recomposition, not because
of a single expensive CPU task. SkipUI maps SwiftUI view bodies into Compose
functions. If a large body reads `MeetingViewModel.shared` or many fields from
`MeetingState`, unrelated state changes can rebuild large subtrees.

The important fixes and patterns:

- Split large views into narrow leaf views.
- Pass primitives into controls and rows where possible instead of the whole
  view model.
- Keep high-frequency state isolated: active speaker, audio levels,
  connection quality, reactions, and stats should be read only by tiny views.
- Stop or throttle high-frequency updates when the stage is obscured by chat,
  transcript, sheets, or overlays.
- Avoid sorting, filtering, formatting, JSON parsing, or large allocations in
  `body`.
- Use cached presentation policies for derived lists, scores, game rows,
  pending users, and transcript groups.
- Avoid broad `.animation(value:)` on large containers. Scope animation to the
  small layer that actually moves or fades.
- Keep stable identities in `ForEach`; do not use indices for dynamic lists.
- Prefer `LazyVStack`/lazy content for sheets and long panels.
- On Android, confirm idle draw cadence is quiet. Watch `ConclavePerf` logs and
  `View: setRequestedFrameRate` spam in logcat.

Useful Android performance signals:

```bash
PID=$(adb shell pidof com.acmvit.conclave)
adb logcat -d | grep " $PID "
adb logcat -d | grep ConclavePerf
adb logcat -d | grep setRequestedFrameRate
```

The expected idle state in a meeting is not constant 60 fps redraws. Lottie
will animate during entry, but it must be removed after reveal.

## Entry Overlay

The meeting-entry overlay is there to hide connection/setup churn. It should
start immediately on New/Join, play the lock sound once, show the branded
Lottie, then fade once the meeting is actually settled.

The robust model is:

- `MeetingState.isEnteringMeeting` records entry intent.
- `MeetingState.meetingEntryStartedAt` provides a hard deadline.
- `MeetingEntryOverlayPolicy.shouldShow(...)` is the source of truth for
  visibility.
- The view model may schedule a nice reveal after `.joined`, but the overlay
  must also have a hard ceiling so a cancelled task cannot leave a black screen.
- Clear entry state on terminal paths: joined after settle, waiting room,
  error, disconnected, and intentional leave.

Do not make the overlay depend only on a fire-and-forget task. View churn can
cancel tasks silently; the policy and observable timestamp are the fallback.

## Lottie On Android And iOS

Android uses the LottieFiles dotLottie player in:

```text
Sources/Conclave/Skip/ConclaveLottie.kt
```

The dependency is declared in:

```text
Sources/Conclave/Skip/skip.yml
```

The Android runtime asset must exist at:

```text
Android/app/src/main/assets/conclave-animation.lottie
```

iOS uses `lottie-ios` from:

```text
Sources/Conclave/Features/Meeting/ConclaveLottieView.swift
Sources/Conclave/Resources/conclave-animation.lottie
```

Important Lottie rules:

- Gate iOS-only Lottie imports with `#if os(iOS)`, not `canImport(Lottie)`.
  `canImport` can be true on the macOS transpile host even when the framework
  is not linked for that target.
- Keep the Android dotLottie player in a small `ComposeView` bridge.
- Use `DotLottieSource.Asset("conclave-animation.lottie")` for the app asset.
- Prewarm native dotLottie libraries from Android diagnostics so first entry
  does not pay the full native load cost.
- Log load, first frame, first render, and load/runtime errors under
  `ConclavePerf` while diagnosing.
- Confirm the APK contains both the asset and native libraries:

```bash
unzip -l apps/conclave-skip/.build/Android/app/outputs/apk/release/app-release.apk | rg "conclave-animation|dotlottie|dlplayer|lottie"
```

## Game Stage Layout Rules

Learned from user feedback on 2026-07-07 (Wordle screenshot review):

- **No floating self view over a game.** The tile strip force-includes the
  local user (`tileStripSnapshot(forceSelfTile: true)` in
  `GameStageTileStrip`); `GameStageCardView` renders no
  `DetachedSelfViewOverlay`. During a game you are a player in the strip like
  everyone else - game inputs must never be obscured.
- **No accent side-bars on game section headers.** Flat title + faint subtitle
  (see `WordleGameView.statusBlock`). The stage chrome already carries game
  identity; body headers state the task quietly. No emoji in status chips -
  the timer is a bordered capsule with plain text.
- **Game boards must fit the compact fold.** Wordle tiles are 38pt/4pt gaps so
  board + field + button + keyboard rows fit an iPhone card without clipping.
- **Keyboard handling (iOS):** the meeting column ignores the keyboard
  (`.ignoresSafeArea(.keyboard)` in MeetingView) and `GameStageCardView` pads
  its body by the real keyboard overlap via `KeyboardFrameObserver` +
  `KeyboardOverlapAvoidance` (`KeyboardOverlap.swift`). Verified on sim: at
  rest, hardware-keyboard focus, and software-keyboard focus - the stage never
  collapses and the focused game input stays visible. Before this fix, typing
  a guess collapsed the stage and floated the controls bar over the game card.
  Android IME behavior is untested on device - verify when a phone is
  available.

## Bottom Sheets

Android meeting sheets are bridged through:

```text
Sources/Conclave/Skip/FlexibleMeetingSheetHost.kt
Sources/Conclave/Features/Meeting/MeetingSheetView.swift
```

Use Skydoves `FlexibleBottomSheet` for native movement, nested scrolling, and
modal behavior. Do not rebuild the old custom sheet.

Sheet rules:

- Let `FlexibleBottomSheet` own show/hide animation on Android.
- Use `allowNestedScroll = true`.
- Keep `windowInsets = WindowInsets(0, 0, 0, 0)` only if the Swift content
  already handles bottom spacing; otherwise verify there is no black bottom
  obstruction.
- The sheet must have a native drag handle, icon rows, and enough bottom
  padding to reveal the end of transcript/game/settings content.
- Do not present a new Skip sheet from a dismissing Skip sheet. On Android,
  close the current sheet first and then open transcript or another panel.
- Use lazy sheet content and avoid recomputing game/catalog rows every frame.

For iOS, keep the standard SwiftUI sheet path. Do not force Android sheet
bridges into iOS.

## Android `onChange` Crash Pattern

SkipUI can crash on Android when the two-parameter `.onChange` form restores a
null old value during high-churn recomposition:

```text
java.lang.NullPointerException: Parameter specified as non-null is null
```

For Android hot paths, prefer the zero-parameter overload whenever the closure
does not truly need old/new values:

```swift
#if SKIP
.onChange(of: someValueKey) {
    updateFromCurrentState()
}
#else
.onChange(of: someValue) { _, newValue in
    update(newValue)
}
#endif
```

This matters especially in:

- `ContentView`
- `MeetingView`
- `ChatViews`
- `ControlsBarView`
- `SettingsSheetView`
- `MeetingBannerOverlay`

Do not casually reintroduce `{ _, _ in }` under `#if SKIP` on entry, sheet,
chat, transcript, or meeting-state paths.

## Native Games Parity

The games sheet should support the whole web-style catalog and the common
server projection shapes:

- Trivia
- Bluff
- Would You Rather
- Most Likely To
- Reaction
- Imposter
- Wordle
- Open vote

Native game detail views should handle lobby, question, reveal, results,
scoreboard, counts, vote splits, per-round points, and read-only spectator
views when the server sends a public view. Keep presentation parsing in testable
policy helpers rather than inline in `body`.

Tests that protect this area live in:

```text
Tests/ConclaveTests/ConclaveTests.swift
```

## SwiftUI And iOS Guidance

For iOS, keep the SwiftUI code idiomatic:

- Prefer `@Observable` and `@State` for owned state in new code.
- Keep `@State` private.
- Use `foregroundStyle`, `clipShape`, and `NavigationStack` patterns when
  adding new views.
- Keep `body` pure and small.
- Avoid `UIScreen.main.bounds`.
- Avoid deep `GeometryReader` dependency when a fixed layout policy is enough.
- Use stable IDs in lists.
- Keep button/icon accessibility labels in place.
- Use the normal SwiftUI `.sheet` path on iOS unless an Android-only bridge is
  explicitly required under `#if SKIP`.

## Design Rules

The native app should match the web app's quiet dark meeting surface:

- No gradients.
- No decorative blobs or atmospheric backgrounds.
- Flat solid surfaces.
- 1 px borders.
- Coral accent for primary action.
- Compact meeting header and room pill.
- Dense but readable controls.
- Real icons in rows and buttons.
- Cards only for repeated items or framed tools, not nested decorative panels.
- Text must fit on compact phones.

Use this scan before declaring UI work done:

```bash
rg -n "Gradient|LinearGradient|RadialGradient|AngularGradient|ACMGradients|gradient" apps/conclave-skip/Sources/Conclave apps/conclave-skip/Android
```

## Device Verification Checklist

Do not mark the handoff goal complete without concrete runtime proof:

- Cold start renders JoinView, not a black screen.
- New meeting as guest starts joining.
- Entry overlay shows visible Lottie and plays sound once.
- Overlay reveals a settled meeting within roughly 2 seconds of ready.
- No black screen remains past the safety cap.
- Join by code works.
- Bad code returns to setup with a branded error path.
- Locked room shows waiting-room behavior.
- Chat opens/closes without Android NPE.
- More sheet opens with native animation, scrolls, and has no bottom obstruction.
- Transcript opens and its last content is visible above bottom safe area.
- Settings and participants sheets open and scroll.
- Invite/share sheet opens without SkipUI preference crashes.
- Idle meeting draw cadence is quiet.
- No gradients.
- `swift build`, `swift test`, Android Kotlin compile, and release assemble pass.

Be precise in final reports: say what was verified on Android real device,
iOS simulator, iOS real device, or only by build/test. Do not turn a simulator
smoke test into a claim of Android device proof.
