#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1bStageMomentsTests {
    static let policyFile = "Sources/Conclave/Features/Meeting/Stage/ChromeAutoHidePolicy.swift"
    static let iosReactionsFile = "Sources/Conclave/Features/Meeting/Stage/Reactions+iOS.swift"
    static let androidReactionsFile = "Sources/Conclave/Skip/ui/call/stage/Reactions.kt"
    static let cellFile = "Sources/Conclave/Features/Meeting/Controls/CallControlCell+iOS.swift"
    static let chromeFile = "Sources/Conclave/Features/Meeting/Stage/StageChrome+iOS.swift"
    static let detailsFile = "Sources/Conclave/Features/Meeting/Stage/MeetingDetailsPanel+iOS.swift"
    static let chipFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveStageChip+iOS.swift"

    private func section(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try #require(text.range(of: start), "missing \(start)")
        let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex), "missing \(end) after \(start)")
        return String(text[lower.upperBound..<upper.lowerBound])
    }

    private func tail(_ text: String, after marker: String, from start: String) throws -> String {
        let anchor = try #require(text.range(of: start), "missing \(start)")
        let split = try #require(text.range(of: marker, range: anchor.upperBound..<text.endIndex), "missing \(marker) after \(start)")
        return String(text[split.upperBound..<text.endIndex])
    }

    private func count(_ needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    @Test func driftDirectionIsDeterministicByEventIdLikeTheLane() {
        let vectors: [(Int, Double)] = [(-1, 1.0), (0, -1.0), (1, -0.5), (2, 0.5), (3, 1.0), (1000, -1.0)]
        for (id, expected) in vectors {
            #expect(StageReactionPolicy.driftDirection(eventId: id) == expected, "\(id)")
        }
        for id in -8...8 {
            #expect(StageReactionPolicy.driftDirection(eventId: id) == StageReactionPolicy.driftDirection(eventId: id + 4), "\(id)")
            let offset = StageReactionPolicy.driftDistance * StageReactionPolicy.driftDirection(eventId: id)
            #expect(offset != 0 && abs(offset) <= StageReactionPolicy.driftDistance, "\(id)")
        }
    }

    @Test func popAndDriftConstantsAreThePolicyValues() {
        #expect(StageReactionPolicy.popMillis == 160.0)
        #expect(StageReactionPolicy.popFromScale == 0.85)
        #expect(StageReactionPolicy.driftDistance == 10.0)
        #expect(StageReactionPolicy.popMillis < StageReactionPolicy.riseMillis)
        #expect(StageReactionPolicy.popFromScale > 0 && StageReactionPolicy.popFromScale < 1)
    }

    @Test func thePolicyPicksTheDirectionWithAModuloSwitchAndNoHash() throws {
        let policy = stageNormalized(try stageSource(Self.policyFile))
        let reactions = try section(policy, from: "enum StageReactionPolicy {", to: "static func opacity(progress: Double) -> Double {")
        #expect(reactions.contains("static let popMillis = 160.0"))
        #expect(reactions.contains("static let popFromScale = 0.85"))
        #expect(reactions.contains("static let driftDistance = 10.0"))
        #expect(reactions.contains("static func driftDirection(eventId: Int) -> Double { switch ((eventId % 4) + 4) % 4 {"))
        for pattern in ["hashValue", "hashCode", "random", "Hasher"] {
            #expect(!policy.contains(pattern), "the reaction policy uses \(pattern)")
        }
    }

    @Test func iosBubblePopsFromThePolicyScaleOnTheSystemSmoothSpring() throws {
        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(ios.contains("init(event: ReactionEvent, reduceMotion: Bool) {"))
        #expect(ios.contains("_popScale = State(initialValue: reduceMotion ? 1 : CGFloat(StageReactionPolicy.popFromScale))"))
        #expect(ios.contains("@State private var popScale: CGFloat") && ios.contains("@State private var drift: CGFloat = 0"))
        #expect(ios.contains("withAnimation(.smooth(duration: StageReactionPolicy.popMillis / 1000.0)) { popScale = 1 }"))
        #expect(count("popScale = 1 }", in: ios) == 1)
        #expect(ios.contains(".scaleEffect(popScale) .offset(x: lane * CGFloat(StageReactionPolicy.laneOffset) + drift, y: -rise)"))
        #expect(ios.contains("guard !box.started else { return } box.started = true"))
        for pattern in [".linear(", ".spring(response:", ".bouncy", "keyframeAnimator", "extraBounce"] {
            #expect(!ios.contains(pattern), "the iOS bubble uses \(pattern)")
        }
    }

    @Test func iosDriftRidesTheRiseAnimationAndTheReducedBranchStaysAtRest() throws {
        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        let start = try section(ios, from: "private func start() {", to: "#endif")
        let reduced = try section(start, from: "if reduceMotion {", to: "} else {")
        for pattern in ["popScale", "drift", "scaleEffect", "rise ="] {
            #expect(!reduced.contains(pattern), "the reduced branch touches \(pattern)")
        }
        #expect(reduced.contains("appear = 1") && reduced.contains("fade = 0"))
        let moving = try section(start, from: "} else {", to: "let fadeStart")
        let rise = try section(moving, from: "withAnimation(.easeOut(duration: riseSeconds)) {", to: "}")
        #expect(rise.contains("rise = CGFloat(StageReactionPolicy.riseDistance)"))
        #expect(rise.contains("drift = CGFloat(StageReactionPolicy.driftDistance * StageReactionPolicy.driftDirection(eventId: event.id))"))
        #expect(count("drift = ", in: ios) == 1)
    }

    @Test func androidBubblePopsOnTheStockSpringAndDriftsOnTheRiseEasing() throws {
        let kotlin = stageNormalized(try stageSource(Self.androidReactionsFile))
        for name in ["import androidx.compose.animation.core.Spring", "import androidx.compose.animation.core.spring",
                     "import androidx.compose.animation.core.LinearOutSlowInEasing", "Spring.DampingRatioNoBouncy",
                     "Spring.StiffnessMedium", "LinearOutSlowInEasing", "popFromScale.toFloat()", "driftDistance).toFloat()",
                     "StageReactionPolicy.driftDirection(event.id)"] {
            #expect(kotlin.contains(name), "Reactions.kt lacks \(name)")
        }
        #expect(!kotlin.contains("popMillis"))
        #expect(!kotlin.contains("EaseOut") && !kotlin.contains("keyframes"))
        #expect(stageMatches(#"val pop = remember \{ Animatable\(if \(reduceMotion\) 1f else [^}]*popFromScale\.toFloat\(\)"#, in: kotlin).count == 1)
        #expect(stageMatches(#"val drift = remember \{ Animatable\(0f\) \}"#, in: kotlin).count == 1)

        let effect = try section(kotlin, from: "LaunchedEffect(Unit) {", to: "val ext = LocalConclaveExtendedColors.current")
        let reduced = try section(effect, from: "if (reduceMotion) {", to: "} else {")
        #expect(!reduced.contains("pop.") && !reduced.contains("drift.") && !reduced.contains("rise."))
        let moving = try section(effect, from: "} else {", to: "val fadeStart")
        #expect(moving.contains("launch { pop.animateTo(") && moving.contains("launch { drift.animateTo("))
        #expect(moving.contains("launch { rise.animateTo("))
        let popSpec = try section(moving, from: "pop.animateTo(1f, spring(", to: "launch {")
        #expect(popSpec.contains("Spring.DampingRatioNoBouncy") && popSpec.contains("Spring.StiffnessMedium"))
        let driftSpec = try tail(moving, after: "drift.animateTo(", from: "launch {")
        for name in ["driftDirection(event.id)", "driftDistance).toFloat()", "tween(riseMillis", "LinearOutSlowInEasing"] {
            #expect(driftSpec.contains(name), "the drift lacks \(name)")
        }

        let layer = try section(kotlin, from: ".graphicsLayer {", to: "},")
        for read in ["translationX = drift.value.dp.toPx()", "translationY = -rise.value.dp.toPx()", "scaleX = pop.value",
                     "scaleY = pop.value", "this.alpha = alpha.value"] {
            #expect(layer.contains(read), "the graphics layer lacks \(read)")
        }
        #expect(count("graphicsLayer", in: kotlin) == 2)
    }

    @Test func theLocalPillIsOpaqueAndCoralWhileRemotePillsKeepTheScrim() throws {
        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        let pill = try section(ios, from: "private var namePill: some View {", to: "private func start() {")
        let iosLocal = try section(pill, from: "if event.isLocal {", to: "} else {")
        #expect(iosLocal.contains(".foregroundStyle(HostingTheme.inCallCoralText)"))
        #expect(iosLocal.contains(".background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Capsule())"))
        #expect(iosLocal.contains(".overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }"))
        #expect(!iosLocal.contains("inCallLabelScrim") && !iosLocal.contains("Material"))
        let iosRemote = try tail(pill, after: "} else {", from: "if event.isLocal {")
        #expect(iosRemote.contains(".background(HostingTheme.inCallLabelScrim, in: Capsule())"))
        #expect(!iosRemote.contains("inCallCoralText"))
        #expect(count("inCallLabelScrim", in: ios) == 1)
        #expect(ios.contains("if event.isLocal { return ConclaveStrings.text(\"You\") }"))

        let kotlin = stageNormalized(try stageSource(Self.androidReactionsFile))
        let androidLocal = try section(kotlin, from: "if (event.isLocal) {", to: "} else {")
        #expect(androidLocal.contains("Surface(shape = CircleShape, color = scheme.surfaceContainerHigh, contentColor = scheme.primary, border = BorderStroke(1.dp, ext.border))"))
        #expect(!androidLocal.contains("labelScrim"))
        let androidRemote = try tail(kotlin, after: "} else {", from: "if (event.isLocal) {")
        #expect(androidRemote.contains("Surface(shape = CircleShape, color = ext.labelScrim, contentColor = scheme.onSurface)"))
        #expect(count("labelScrim", in: kotlin) == 1)
        #expect(kotlin.contains("event.isLocal -> conclaveString(\"ds_you\")"))
    }

    @Test func theTouchedFilesUseNoLoopApi() throws {
        for file in [Self.policyFile, Self.iosReactionsFile, Self.androidReactionsFile, Self.cellFile, Self.chromeFile, Self.detailsFile] {
            let text = try stageSource(file)
            for pattern in ["repeatForever", "infiniteRepeatable", "rememberInfiniteTransition", "TimelineView", "while (true)", "while true",
                            "options: .repeating", ".spring(response:"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }
        let kotlin = try stageSource(Self.androidReactionsFile)
        for pattern in ["clickable", "pointerInput", "MotionScheme"] {
            #expect(!kotlin.contains(pattern), "Reactions.kt uses \(pattern)")
        }
        #expect(stageNormalized(kotlin).contains("clearAndSetSemantics { }"))
        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        #expect(ios.contains(".allowsHitTesting(false) .accessibilityHidden(true)"))
    }

    @Test func theCallBarGlyphUsesMagicReplaceBehindAvailabilityInsideASnapTransaction() throws {
        let cell = stageNormalized(try stageSource(Self.cellFile))
        let glyph = try section(cell, from: "struct CallControlGlyph: View {", to: "struct CallControlSurfaceStyle: ButtonStyle {")
        #expect(glyph.contains("@Environment(\\.accessibilityReduceMotion) private var reduceMotion"))
        #expect(glyph.contains("Image(systemName: systemImage) .font(.title3) .imageScale(.medium) .contentTransition(reduceMotion ? .identity : glyphTransition) .animation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion), value: systemImage)"))
        #expect(glyph.contains("private var glyphTransition: ContentTransition { if #available(iOS 18.0, *) { return .symbolEffect(.replace.magic(fallback: .replace)) } return .symbolEffect(.replace) }"))
        #expect(count(".magic(", in: cell) == 1)
        let beforeMagic = try section(glyph, from: "private var glyphTransition: ContentTransition {", to: ".magic(")
        #expect(beforeMagic.contains("if #available(iOS 18.0, *) {"))
        #expect(!cell.contains(".nonRepeating") && !cell.contains("MagicReplace"))
        for key in ["Microphone Access Is Off", "Camera Access Is Off", "Open Settings"] {
            #expect(cell.contains("ConclaveStrings.text(\"\(key)\")"), "\(key)")
        }
    }

    @Test func theRaisedHandChipPlaysOnceWhenAnArmedRaiseLandsAndHonoursReduceMotion() throws {
        let chrome = stageNormalized(try stageSource(Self.chromeFile))
        let chips = try section(chrome, from: "struct StageStatusChips: View {", to: "struct StageHandChip: View {")
        #expect(chips.contains("@State private var raiseCount = 0"))
        #expect(chips.contains("@State private var raiseArmed = false"))
        #expect(chips.contains("@Environment(\\.accessibilityReduceMotion) private var reduceMotion"))
        #expect(chips.contains(".onChange(of: stage.localHand, initial: true) { _, new in if new == LocalHandState.raising { raiseArmed = true } else if new == LocalHandState.lowered { raiseArmed = false } else if new == LocalHandState.raised { if raiseArmed { raiseCount += 1 } raiseArmed = false } }"))
        #expect(count("raiseCount += 1", in: chrome) == 1)
        #expect(count("raiseCount = ", in: chrome) == 1)
        #expect(count("raiseArmed = true", in: chrome) == 1)
        #expect(count("raiseArmed = false", in: chrome) == 3)
        #expect(count(".onChange(of: stage.localHand", in: chrome) == 1)
        #expect(!chips.contains("LocalHandState.lowering") && !chips.contains("old =="))
        #expect(chips.contains("if #available(iOS 18.0, *) { StageHandChip(stage: stage).symbolEffectsRemoved(reduceMotion).symbolEffect(.wiggle, value: raiseCount) } else { StageHandChip(stage: stage).symbolEffectsRemoved(reduceMotion).symbolEffect(.bounce, value: raiseCount) }"))
        #expect(count(".symbolEffect(", in: chips) == 2)
        #expect(count(".symbolEffectsRemoved(reduceMotion).symbolEffect(", in: chips) == 2)
        #expect(!chips.contains(".nonRepeating") && !chips.contains("isActive:"))
        let hand = try section(chrome, from: "struct StageHandChip: View {", to: "struct StageNowPlayingChip: View {")
        #expect(!hand.contains("symbolEffect") && !hand.contains("raiseCount") && !hand.contains("raiseArmed"))
        #expect(!(try stageSource(Self.chipFile)).contains("symbolEffect"))
    }

    @Test func meetingDetailsCopyGlyphsReplaceInsideASnapTransactionWithNoNewTimer() throws {
        let raw = try stageSource(Self.detailsFile)
        let details = stageNormalized(raw)
        let transition = ".contentTransition(reduceMotion ? .identity : .symbolEffect(.replace)) .animation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion), value: showsCopied)"
        #expect(count(transition, in: details) == 2)
        let copyRow = try section(details, from: "private struct MeetingDetailsCopyRow: View {", to: "private struct MeetingDetailsWebinarShareRow: View {")
        let webinarRow = try section(details, from: "private struct MeetingDetailsWebinarCopyRow: View {", to: "private struct MeetingDetailsHostControlsRow: View {")
        #expect(copyRow.contains("Label(showsCopied ? ConclaveStrings.text(\"Copied\") : title, systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc) " + transition))
        #expect(webinarRow.contains("Label(showsCopied ? ConclaveStrings.text(\"Copied\") : ConclaveStrings.text(\"Copy Link\"), systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc) " + transition))
        for row in [copyRow, webinarRow] {
            #expect(count("@Environment(\\.accessibilityReduceMotion) private var reduceMotion", in: row) == 1)
        }
        #expect(count("@State private var", in: copyRow) == 2 && count("@State private var", in: webinarRow) == 3)
        #expect(count("Task.sleep", in: raw) == 2)
        #expect(count("@State", in: raw) == 7)
        #expect(count("AccessibilityNotification.Announcement(", in: raw) == 2)
        for pattern in ["Timer", "DispatchQueue", "asyncAfter", ".magic("] {
            #expect(!raw.contains(pattern), "Meeting Details uses \(pattern)")
        }
    }
}
#endif
