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

Plain `swift build` / `swift test` work on Swift 6.4's default build engine; no
`--build-system native` flag or `swift` PATH shim is needed. The app is Skip
Lite only (every module transpiled). Do not add `skip-fuse` back: it made the
SwiftPM graph fail on the default engine, shipped about 100 MB per ABI of
Swift runtime/ICU/Foundation `.so` files, and made `assembleRelease`
cross-compile Swift with a separate Swift-for-Android toolchain.

Android uses the checked-in Gradle wrapper (`Android/gradlew`, Gradle 9.7.1,
distribution SHA-256 pinned). The gates are verified with JDK 21 (AGP 9.2
needs JDK 17 or newer); pin `JAVA_HOME` so Gradle does not pick up whatever
the machine default JDK happens to be:

```bash
cd apps/conclave-skip/Android
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
./gradlew :Conclave:compileDebugKotlin --console=plain
ALLOW_DEBUG_RELEASE_SIGNING=true ./gradlew :app:assembleRelease --console=plain
```

The Xcode "Run skip gradle" phase (default `SKIP_ACTION=build`) and
`Android/fastlane` go through the same wrapper and default `JAVA_HOME` to the
Homebrew JDK 21 when it is unset. `skip gradle` ignores `--gradle` and
`--java-home` and runs the first `gradle` on `PATH` (falling back to the
Homebrew `java` JDK), so the phase puts a `gradle` shim that execs
`Android/gradlew` first on `PATH`; no Homebrew Gradle is needed.

`Android/settings.gradle.kts` runs `skip plugin --prebuild` plus a host
`swift build --scratch-path .build/index-build` before Gradle configures. It
runs the skip CLI that SwiftPM resolved from `Package.resolved`
(`.build/artifacts/skip/skip/skip.artifactbundle/macos/skip`), so the Gradle
plugin always matches the skipstone transpiler version regardless of the
Homebrew `skip` version. On a fresh clone run `swift build` once first; until
then it falls back to `skip` on `PATH`. If the prebuild fails, run
`swift build` directly to see the real error.

The local release APK is written to:

```text
apps/conclave-skip/.build/Android/app/outputs/apk/release/app-release.apk
```

It is about 120 MB (mostly un-minified DEX) with 7 small native libs per ABI
(mediasoup, libc++, dotLottie, CameraX, androidx graphics); the arm64 and
x86_64 ones are all 16 KB aligned. If `libswiftCore.so`, `libFoundation*.so`, `lib_FoundationICU.so` or
`libSkipAndroidBridge.so` ever reappear in `unzip -l`, something pulled
SkipFuse or a native-mode Skip module back in.

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

The unsigned iOS device Release gate uses the same flags (`SKIP_ACTION=none`
keeps the "Run skip gradle" phase from launching Gradle):

```bash
xcodebuild \
  -project apps/conclave-skip/Darwin/Conclave.xcodeproj \
  -scheme "Conclave App" \
  -configuration Release \
  -destination generic/platform=iOS \
  -derivedDataPath /tmp/conclave-ios-dd-release \
  -skipPackagePluginValidation \
  -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO \
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

## Connection Recovery Watchdog

The reconnect state machine (onDisconnected → reconnecting → rejoin) is driven
by fire-and-forget tasks with in-flight guards (`isRejoinInFlight`,
`shouldRejoinAfterReconnect`, attempt-id checks). Overlapping triggers can
strand it: a superseded join attempt bails on its attempt-id guard without
resetting the flags, after which every recovery entry point is guard-blocked.
Reproduced 2026-07-14 on the simulator: ~16 min idle in a quiet room, then a
permanent "Connection interrupted" banner; even background/foreground could
not restart recovery.

`ConnectionRecoveryWatchdogPolicy` (Models.swift, unit-tested) is the
backstop, same philosophy as the entry overlay: pure policy over observable
timestamps. `beginConnectionRecovery` stamps `recoveryStartedAt` and starts a
tick; a stall (no join activity for 25 s) force-resets the guards and rejoins
fresh; passing the 120 s hard cap fails out to the error screen with a retry.
Do not add new recovery entry points that only honor the in-flight flags -
stamp `lastJoinActivityAt` on real progress and let the watchdog break ties.

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

## Appearance-Callback Render Loop (100% CPU, 0x8BADF00D)

Proven on iOS sim 2026-07-17 while landing chat images. `onAppear`/`onDisappear`
closures are re-merged and can RE-FIRE whenever the owning body re-runs (the
profile shows `_AppearanceActionModifier.MergedBox.update()` invoking them). If
such a callback writes `@State`, the write re-invalidates body, which re-fires
the callback: the view spins at 100% CPU forever. Symptoms: XCUITest/agent-device
"Daemon request timed out" (the app never reaches quiescence), frozen mid
transition screenshots, and - if the app then backgrounds - a FrontBoard
watchdog kill (`0x8BADF00D` "exhausted CPU time allowance", visible in
`~/Library/Logs/DiagnosticReports`).

Rules:

- Appearance callbacks must not write observed view state. Track high-churn
  flags (scroll sentinels, visibility latches) in a plain reference box held in
  `@State` (`ChatBottomSentinelBox` in ChatViews.swift): mutating a field does
  not invalidate, and event handlers (onChange) read it on demand.
- Any @State write an appearance callback must make (e.g. clearing the unseen
  pill) must be value-guarded so it is a no-op almost always.
- Rows whose height depends on async load phase (AsyncImage placeholder vs
  loaded) must reserve a FIXED frame for every phase. LazyVStack evicts row
  state off-screen, so phase-sized frames make content height oscillate, which
  re-solves bottom-anchored scrolls and re-toggles sentinels.
- Diagnose with `sample <pid> 5 -file out.txt`: the repeating body getter and
  `StoredLocationBase.set` under `AppearanceActionModifier` name the writer.

Known deferred caveat: SkipUI `AsyncImage` on Android decodes at Coil
`Size.ORIGINAL` (no downsampling), so a 6 MB high-resolution chat image can
decode into a very large bitmap. Verify memory on a real Android device; if it
is a problem, bridge a bounded-size Coil request.

## Socket Ack Shapes (server `(_data, callback)` vs `(callback)`)

SFU handlers come in two shapes and each needs the matching client emit:

- `(callback) => {}` (e.g. getProducers): emit ack-only, NO payload
  (`emitAckOnly`). A `{}` payload would bind to `callback`.
- `(_data, callback) => {}` (e.g. `chat:imageUploadAuthorize`): emit an EMPTY
  `{}` payload (`emit(event, EmptySocketPayload())` / Kotlin
  `emit(event, JSONObject())`). Ack-only binds the ack fn to `_data`, the
  server answers a callback that does not exist, and the client times out
  after 30s - surfaced as a generic failure, so check this FIRST when a new
  ack round-trip "has no connection".

Check the handler signature in `packages/sfu/server/socket/handlers/` before
wiring any new ack event.

## Chat Message Reconstruction Sites

`ChatMessage` gets REBUILT (not copied) in several places; a new field with an
init default silently vanishes at any site that omits it. When adding a field
(gif, image, replyTo, ...), update ALL of: `normalizedChatMessage` (both
branches), `refreshChatDisplayName`, `mergedConclaveAssistantMessage`,
`appendOptimisticChatMessage` in MeetingViewModel.swift; the Kotlin decoders
`decodeChatMessageObject` / `decodeChatReplyPreviewObject` /
`decodeConclaveAssistantMessage` in SocketIOManager+Android.kt (hand-rolled
JSON, NOT transpiled); and the test fixtures. The image field was dropped by
`normalizedChatMessage` on every receive until 2026-07-17.

## Media Threading And Lifecycle Invariants

Fixed 2026-10-22 and guarded by `testNativeCallCorrectnessBlockersStayFixed`:

- Never add or remove a video sink inside a frame callback (Android
  `VideoSink.onFrame`, iOS `RTCVideoRenderer.renderFrame`). Frames arrive on
  the decode thread while WebRTC holds the broadcaster sink lock, so a
  synchronous `removeSink`/`remove` deadlocks remote video (the Android ANR).
  Post the detach to the main thread, as `FirstDecodedVideoFrameObserver` and
  `FirstDecodedVideoFrameRenderer` do.
- iOS: never call mediasoup `createProducer` on the MainActor. The wrapper
  blocks on `onProduce`, which hops to the MainActor for socket signaling.
  Use `createProducerOffMain` / `createScreenProducerOffMain`, then re-check
  generation and ownership after the await before committing. The await lets
  other MainActor work run: a microphone start also compares
  `localAudioMuteIntentGeneration` and drops its producer if a mute landed
  meanwhile, and a mute with no producer yet still reaches the client
  (`disableLocalAudioIfNeeded` calls `suspendLocalAudioForRecovery`). Do not
  throw `staleConfiguration` for a superseded-but-same-session start (mic or
  camera); callers treat "session was replaced" as a reason to force a rejoin.
- iOS: every blocking libmediasoupclient send-side call (producer create and
  close, send transport close, send ICE restart) runs on the serial
  `sendTransportOperationQueue` (`performSendTransportOperation`,
  `closeSendProducer`, `closeSendTransport`), never directly and never via
  `sync`. SendTransport/SendHandler state is unsynchronized, and the queued
  transport close keeps the Device alive until any in-flight create is done.
- iOS: the SFU closes a displaced producer and broadcasts `producerClosed`
  for it to the owner before acking the replacement, so with off-main creates
  that event reaches the view model first. Microphone replacements (bandwidth
  refresh, route recovery) mark the predecessor in
  `intentionalLocalAudioProducerCloseIds` before the create, and
  `handleLocalProducerClosed` consumes it (like the video marker). Once the
  replacement's create returns in the same session, never fall back to the
  predecessor: commit the replacement, paused and server-muted if a mute
  landed (`isLocalAudioMuteInEffect`). `startProducingAudio` is single-flight
  (`audioStartTask`) so two starts never race a produce, and microphone tracks
  are created disabled and enabled only by a live commit.
- A failed mute fails closed on both platforms: `setAudioEnabled(false)`
  keeps the producer paused and the track silent, and the view model stays
  muted while showing the error.
- Mic, camera and hand toggle guards (`isMuteToggleInFlight`,
  `isCameraToggleInFlight`, `isHandRaiseToggleInFlight`) derive from a
  per-toggle token (`muteToggleToken` and siblings). A completion clears its
  guard only while it still owns the token, and `joinRoom` releases all
  three for every new attempt through `releaseLocalToggleGuards()`, as
  `cleanup()` does, because recovery rejoins skip `cleanup()` and an SFU ack
  can take 30 s. Never clear a guard by call context: a rejoin landing
  mid-await stranded it and turned later toggles, CallKit and notification
  mutes into silent no-ops (F7, fixed 2026-10-24, also covered by
  `LocalToggleGuardRecoveryTests`). After its await, an orphaned toggle
  re-checks `isCurrentJoinedCall` before touching the attempt that replaced
  it: the unmute confirmation (it bypasses the guard via
  `allowCurrentMuteToggle`), the chat camera-on commit, and the
  `enableOrStartLocalVideo` recreate fallback. A toggle that still owns
  its token keeps suppressing the `handleLocalProducerClosed` restart.
- A view-model check after an await cannot stop effects inside the awaited
  media call, so both clients fence late acknowledgements themselves, as
  `setAudioEnabled` does. `reassertLocalAudioProducerUnmuted` re-checks the
  configuration generation, mute-intent generation and producer identity
  after its ack and never re-enables capture for an orphaned confirmation
  (that would be a live mic while muted). `setVideoEnabled` re-checks the
  configuration generation, `localVideoOffIntentGeneration` (bumped by every
  camera-off that keeps the producer: `setVideoEnabled(false)`,
  `suspendLocalVideoForRecovery()`) and producer identity before its success
  effects and before its rollback. Both write `localVideoEnabled` and fire
  `onLocalVideoEnabledChanged` (iOS through the `didSet`). A newer camera-off
  or a replacement producer keeps the camera; with no producer left the
  error goes back so the caller can recreate one. Android re-checks the same
  after its permission prompt and the 350 ms pre-join preview release (both
  suspend), before restarting capture; its camera start re-checks the
  configuration after that release and clears only camera state its own
  session still owns. `enableOrStartLocalVideo(context:)` acts for its
  caller's call context and checks it before any close or restart. Pinned by
  `testLateMediaAcknowledgementsAreFencedInBothClients`.
- Android `Main.kt` must keep `SideEffect { saveableStateHolder.removeState(...) }`
  inside the root `SaveableStateProvider` (Skip app template). Restoring SkipUI
  saved state after the PiP swap or activity recreation NPEs in
  `PresentationRoot`.
- Keep-awake (`CallScreenAwake`) and the Android POST_NOTIFICATIONS request
  hang off `activateCallPresence()` / `deactivateCallPresence()`; the
  notification prompt waits until the meeting-entry overlay has cleared and
  rendered away (a short deferred re-check). Only terminal call end
  (`deactivateCallPresence()` ->
  `PermissionHelper.dropQueuedNotificationsPermissionRequest()`) drops a
  queued prompt; `cancelPendingCallPermissionRequests()` also runs on
  recovery rejoins and must keep it. A request that never reached the user
  (dropped, no activity, or cancelled by Android behind another dialog) does
  not use up the once-per-process ask
  (`wasLastNotificationsPermissionRequestAnswered()`).

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
