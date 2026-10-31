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
        #expect(ios.contains("init(event: ReactionEvent, reduceMotion: Bool, slotShape: StageReactionSlotShape, slotHeight: Double) {"))
        #expect(ios.contains("_popScale = State(initialValue: reduceMotion ? 1 : CGFloat(StageReactionPolicy.popFromScale))"))
        #expect(ios.contains("@State private var popScale: CGFloat") && ios.contains("@State private var drift: CGFloat = 0"))
        #expect(ios.contains("withAnimation(.smooth(duration: StageReactionPolicy.popMillis / 1000.0)) { popScale = 1 }"))
        #expect(count("popScale = 1 }", in: ios) == 1)
        #expect(ios.contains("let lane = StageReactionPolicy.lane(for: event.id) let slotX = CGFloat(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: reduceMotion, shape: slotShape)) let slotY = CGFloat(StageReactionPolicy.slotOffsetY(lane: lane, shape: slotShape, slotHeight: slotHeight))"))
        #expect(ios.contains(".scaleEffect(popScale) .offset(x: slotX + drift, y: -rise - slotY)"))
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

    private func reactionEvent(_ id: Int) -> ReactionEvent {
        ReactionEvent(id: id, senderName: "", isLocal: false, kind: "emoji", value: "x", label: "x")
    }

    private func reactionSnapshot(_ ids: [Int], renderLimit: Int = 20) -> StageReactionsSnapshot {
        var events: [ReactionEvent] = []
        for id in ids { events.append(reactionEvent(id)) }
        return StageReactionsSnapshot(revision: 1, events: events, renderLimit: renderLimit)
    }

    @Test func reducedMotionShowsTheNewestReactionPerLaneInSlotsThatNeverOverlap() throws {
        let burst = reactionSnapshot(Array(1...25))
        let reduced = StageReactionPolicy.visibleEvents(burst, reduceMotion: true)
        #expect(reduced.map(\.id) == [23, 24, 25])
        #expect(reduced.map { StageReactionPolicy.lane(for: $0.id) } == [2, 0, 1])
        #expect(StageReactionPolicy.visibleEvents(reactionSnapshot([1, 4, 7, 8]), reduceMotion: true).map(\.id) == [7, 8])
        #expect(StageReactionPolicy.visibleEvents(reactionSnapshot([3, 1, 4, 6, 2]), reduceMotion: true).map(\.id) == [4, 6, 2])
        #expect(StageReactionPolicy.visibleEvents(reactionSnapshot(Array(1...25), renderLimit: 2), reduceMotion: true).map(\.id) == [24, 25])
        #expect(StageReactionPolicy.visibleEvents(reactionSnapshot([]), reduceMotion: true).isEmpty)

        let moving = StageReactionPolicy.visibleEvents(burst, reduceMotion: false)
        #expect(moving.count == 20 && moving.first?.id == 6 && moving.last?.id == 25)
        #expect(moving == StageReactionPolicy.visibleEvents(burst))

        #expect(StageReactionPolicy.reducedLaneOffset == 72.0)
        #expect(StageReactionPolicy.reducedSlotWidth == 64.0)
        #expect(StageReactionPolicy.reducedSlotWidth >= StageReactionPolicy.bubbleDiameter)
        #expect(StageReactionPolicy.reducedLaneOffset == StageReactionPolicy.reducedSlotWidth + 8)
        #expect((StageReactionPolicy.reducedSlotWidth - StageReactionPolicy.bubbleDiameter) / 2 == 8)
        #expect(StageReactionPolicy.laneOffset == 20.0 && StageReactionPolicy.laneCount == 3)
        let slotsEnd = StageReactionPolicy.leadingInset + Double(StageReactionPolicy.laneCount - 1) * StageReactionPolicy.reducedLaneOffset
            + StageReactionPolicy.reducedSlotWidth
        #expect(slotsEnd == 220 && slotsEnd <= 360)

        for count in 0...25 {
            for limit in [8, 12, 20] {
                let snapshot = reactionSnapshot(Array(stride(from: 1, through: count, by: 1)), renderLimit: limit)
                let limited = StageReactionPolicy.visibleEvents(snapshot).map(\.id)
                let shown = StageReactionPolicy.visibleEvents(snapshot, reduceMotion: true).map(\.id)
                let lanes = shown.map { StageReactionPolicy.lane(for: $0) }
                #expect(shown.count <= StageReactionPolicy.laneCount, "\(count) \(limit)")
                #expect(Set(lanes).count == lanes.count, "\(count) \(limit)")
                #expect(Set(lanes) == Set(limited.map { StageReactionPolicy.lane(for: $0) }), "\(count) \(limit)")
                #expect(shown == shown.sorted(), "\(count) \(limit)")
                for id in shown {
                    let newest = limited.last { StageReactionPolicy.lane(for: $0) == StageReactionPolicy.lane(for: id) }
                    #expect(newest == id, "\(count) \(limit) \(id)")
                }
                for first in lanes {
                    for second in lanes where first != second {
                        let gap = abs(Double(first - second)) * StageReactionPolicy.reducedLaneOffset - StageReactionPolicy.reducedSlotWidth
                        #expect(gap >= 8, "\(count) \(limit)")
                    }
                }
            }
        }

        let policy = stageNormalized(try stageSource(Self.policyFile))
        let reactions = try section(policy, from: "enum StageReactionPolicy {", to: "static func opacity(progress: Double) -> Double {")
        #expect(reactions.contains("static let reducedLaneOffset = 72.0 static let reducedSlotWidth = 64.0 static let reducedPillMaxFontScale = 1.5"))
        #expect(reactions.contains("static func visibleEvents(_ snapshot: StageReactionsSnapshot, reduceMotion: Bool) -> [ReactionEvent] { let limited = visibleEvents(snapshot) if !reduceMotion { return limited }"))
        #expect(reactions.contains("while index >= 0 && picked.count < laneCount {"))

        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        #expect(ios.contains("let events = StageReactionPolicy.visibleEvents(stage.reactions, reduceMotion: reduceMotion)"))
        #expect(count("visibleEvents(", in: ios) == 1)
        #expect(ios.contains("if reduceMotion { namePill .truncationMode(.tail) .frame(maxWidth: CGFloat(StageReactionPolicy.reducedSlotWidth)) .dynamicTypeSize(...DynamicTypeSize.xxxLarge) } else { namePill }"))
        #expect(ios.contains("let label = Text(name) .font(.caption2) .lineLimit(1) .padding(.horizontal, 6)"))
        #expect(count("reducedLaneOffset", in: ios) == 0)
        #expect(count("slotOffsetX(", in: ios) == 1 && count("slotOffsetY(", in: ios) == 1)
        #expect(count("reducedSlotWidth", in: ios) == 1)

        let kotlin = stageNormalized(try stageSource(Self.androidReactionsFile))
        #expect(kotlin.contains("val reduceMotion = rememberReduceMotion() val events = remember(snapshot, reduceMotion) { StageReactionPolicy.visibleEvents(snapshot, reduceMotion).toList() }"))
        #expect(count("visibleEvents(", in: kotlin) == 1)
        #expect(kotlin.contains(".offset(x = StageReactionPolicy.slotOffsetX(lane = lane, reduceMotion = reduceMotion, shape = slotShape).dp, y = (-StageReactionPolicy.slotOffsetY(lane = lane, shape = slotShape, slotHeight = slotHeight)).dp) .then(if (reduceMotion) Modifier.width(StageReactionPolicy.reducedSlotWidth.dp) else Modifier).graphicsLayer {"))
        #expect(count("reducedLaneOffset", in: kotlin) == 0)
        #expect(count("reducedSlotWidth", in: kotlin) == 1)
        #expect(kotlin.contains("import androidx.compose.foundation.layout.width "))
        #expect(!kotlin.contains("pillWidth") && !kotlin.contains("widthIn"))
        #expect(kotlin.contains("style = labelStyle, maxLines = 1, overflow = TextOverflow.Ellipsis"))
    }

    @Test func theReducedPillFitsSomeoneAtDefaultTextAndCapsLargeTextOnBothPlatforms() throws {
        let pillPadding = 6.0
        #expect(StageReactionPolicy.reducedSlotWidth - 2 * pillPadding >= 51)
        #expect(StageReactionPolicy.reducedPillMaxFontScale == 1.5)

        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        #expect(ios.contains("let label = Text(name) .font(.caption2) .lineLimit(1) .padding(.horizontal, 6) .padding(.vertical, 2)"))
        #expect(count(".dynamicTypeSize(...DynamicTypeSize.xxxLarge)", in: ios) == 1)
        let reducedPill = try section(ios, from: "if reduceMotion { namePill", to: "} else { namePill }")
        #expect(reducedPill.contains(".dynamicTypeSize(...DynamicTypeSize.xxxLarge)"))

        let kotlin = stageNormalized(try stageSource(Self.androidReactionsFile))
        #expect(kotlin.contains("val fontScale = LocalDensity.current.fontScale val pillMaxFontScale = StageReactionPolicy.reducedPillMaxFontScale.toFloat() val labelBase = MaterialTheme.typography.labelSmall"))
        #expect(kotlin.contains("val labelStyle = if (reduceMotion && fontScale > pillMaxFontScale) { val shrink = pillMaxFontScale / fontScale labelBase.copy(fontSize = labelBase.fontSize * shrink, lineHeight = labelBase.lineHeight * shrink, letterSpacing = labelBase.letterSpacing * shrink) } else { labelBase }"))
        #expect(kotlin.contains("val label: @Composable () -> Unit = { ConclaveText(name, line = \"stage.reaction.${event.id}.name\", style = labelStyle, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)) }"))
        #expect(count("labelStyle", in: kotlin) == 2)
        #expect(kotlin.contains("import androidx.compose.ui.platform.LocalDensity"))
        #expect(!kotlin.contains("LocalDensity provides") && !kotlin.contains("CompositionLocalProvider"))
        let androidLocal = try section(kotlin, from: "if (event.isLocal) {", to: "} else {")
        #expect(androidLocal.contains("Surface(shape = CircleShape, color = scheme.surfaceContainerHigh, contentColor = scheme.primary, border = BorderStroke(1.dp, ext.border)) { label() }"))
        let androidRemote = try tail(kotlin, after: "} else {", from: "if (event.isLocal) {")
        #expect(androidRemote.contains("Surface(shape = CircleShape, color = ext.labelScrim, contentColor = scheme.onSurface) { label() }"))
    }

    @Test func theReactionLayerRisesWithTheTileLabelSoPillsNeverCoverItAtLargeText() throws {
        let androidBar = 76.0
        let iosBar = 64.0
        let androidLine = 16.0
        let iosDefaultLine = 15.5
        #expect(StageReactionPolicy.layerLift == 64.0)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: androidLine, defaultLabelLineHeight: androidLine) == 140)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: androidLine * 1.5, defaultLabelLineHeight: androidLine) == 148)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: androidLine * 2.0, defaultLabelLineHeight: androidLine) == 156)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: androidLine * 0.85, defaultLabelLineHeight: androidLine) == 140)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: iosBar, labelLineHeight: iosDefaultLine, defaultLabelLineHeight: iosDefaultLine) == 128)
        #expect(abs(StageReactionPolicy.layerBottomInset(barReserve: iosBar, labelLineHeight: 22.7, defaultLabelLineHeight: iosDefaultLine) - 135.2) < 0.0001)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: iosBar, labelLineHeight: 13.0, defaultLabelLineHeight: iosDefaultLine) == 128)

        let labelInset = 8.0
        let labelPadding = 4.0
        let mutedIcon = 16.0
        let paddings = [StageLayoutPolicy.compactPadding, StageLayoutPolicy.regularPadding, StageViewportPolicy.tileControlGap]
        for scale in [0.85, 1.0, 1.15, 1.3, 1.5, 1.8, 2.0] {
            let line = androidLine * scale
            let layer = StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: line, defaultLabelLineHeight: androidLine)
            for padding in paddings {
                let labelTop = androidBar + padding + labelInset + 2 * labelPadding + max(mutedIcon, line)
                #expect(abs((layer - labelTop) - (32 - padding)) < 0.0001, "android \(scale) \(padding)")
                #expect(layer - labelTop >= 16 - 0.0001, "android \(scale) \(padding)")
            }
        }
        for growth in [-2.0, 0.0, 2.4, 4.8, 7.2] {
            let line = iosDefaultLine + growth
            let layer = StageReactionPolicy.layerBottomInset(barReserve: iosBar, labelLineHeight: line, defaultLabelLineHeight: iosDefaultLine)
            for padding in paddings {
                let labelTop = iosBar + padding + labelInset + 2 * labelPadding + line
                #expect(layer - labelTop >= 16 - 0.0001, "ios \(growth) \(padding)")
                if growth >= 0 {
                    #expect(abs((layer - labelTop) - (32.5 - padding)) < 0.0001, "ios \(growth) \(padding)")
                }
            }
        }

        let policy = stageNormalized(try stageSource(Self.policyFile))
        let reactions = try section(policy, from: "enum StageReactionPolicy {", to: "static func opacity(progress: Double) -> Double {")
        #expect(reactions.contains("static let leadingInset = 12.0 static let layerLift = 64.0 static func layerBottomInset(barReserve: Double, labelLineHeight: Double, defaultLabelLineHeight: Double) -> Double { barReserve + layerLift + max(0.0, labelLineHeight - defaultLabelLineHeight) }"))

        let kotlin = stageNormalized(try stageSource(Self.androidReactionsFile))
        let burstLayer = try section(kotlin, from: "internal fun ReactionBurstLayer(", to: "private fun ReactionBubble(")
        #expect(burstLayer.contains("val tileLabelLine = MaterialTheme.typography.labelMedium.lineHeight.value.toDouble() val bottomInset = StageReactionPolicy.layerBottomInset(barReserve = StageCanvasMetrics.BAR_RESERVE_DP, labelLineHeight = tileLabelLine * LocalDensity.current.fontScale, defaultLabelLineHeight = tileLabelLine)"))
        #expect(burstLayer.contains("BoxWithConstraints(modifier.fillMaxSize().clearAndSetSemantics { }) {"))
        #expect(burstLayer.contains("Box( Modifier.fillMaxSize() .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Start)) .padding(start = StageReactionPolicy.leadingInset.dp, bottom = placement.bottomInset.dp),"))
        #expect(burstLayer.contains("} else { StageReactionSlotPlacement(bottomInset = bottomInset, shape = StageReactionSlotShape.row) }"))
        #expect(count("layerBottomInset(", in: kotlin) == 1)
        #expect(!kotlin.contains("+ 64"))
        for name in ["WindowInsets", "WindowInsetsSides", "only", "safeDrawing", "windowInsetsPadding"] {
            #expect(kotlin.contains("import androidx.compose.foundation.layout.\(name) "), "Reactions.kt lacks the \(name) import")
        }

        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP import SwiftUI import UIKit "))
        #expect(ios.contains("@Environment(\\.dynamicTypeSize) private var dynamicTypeSize"))
        #expect(ios.contains("ReactionBurstColumn(stage: stage, reduceMotion: reduceMotion, bottomInset: bottomInset, slots: reducedSlots)"))
        #expect(ios.contains("let tileLabelSize = min(dynamicTypeSize, DynamicTypeSize.xxxLarge)"))
        #expect(ios.contains("let tileLabel = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(tileLabelSize)))"))
        #expect(ios.contains("let defaultLabel = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))"))
        #expect(ios.contains("return CGFloat(StageReactionPolicy.layerBottomInset(barReserve: Double(StageCanvasMetrics.barReserve), labelLineHeight: Double(tileLabel.lineHeight), defaultLabelLineHeight: Double(defaultLabel.lineHeight)))"))
        #expect(ios.contains(".padding(.leading, CGFloat(StageReactionPolicy.leadingInset)) .padding(.bottom, CGFloat(placement.bottomInset)) .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)"))
        #expect(ios.contains("let placement = reduceMotion ? reducedPlacement : StageReactionSlotPlacement(bottomInset: Double(bottomInset), shape: .row)"))
        #expect(count("layerBottomInset(", in: ios) == 1)
        #expect(!ios.contains("+ 64"))

        let androidCanvas = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/StageCanvas.kt"))
        #expect(androidCanvas.contains("const val BAR_RESERVE_DP = 76.0"))
        #expect(androidCanvas.contains("val insets = WindowInsets.safeDrawing"))
        #expect(androidCanvas.contains("bottom = insets.getBottom(density) / scale,"))
        let iosCanvas = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageCanvas+iOS.swift"))
        #expect(iosCanvas.contains("static let barReserve: CGFloat = 64"))

        let androidTile = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/components/ConclaveTileChrome.kt"))
        #expect(androidTile.contains("val inset = if (density == TileChromeDensity.dense) 4.dp else 8.dp"))
        #expect(androidTile.contains("Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,"))
        #expect(androidTile.contains("if (model.isMuted) Icon(ConclaveIcons.MicOffFill1, contentDescription = null, modifier = Modifier.size(16.dp), tint = scheme.onSurface)"))
        #expect(androidTile.contains("style = if (density == TileChromeDensity.dense) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium,"))
        let iosTile = stageNormalized(try stageSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveTileChrome+iOS.swift"))
        let overlays = try section(iosTile, from: "private struct TileOverlays<SelfViewAccessory: View>: View {", to: "private struct MutedBadge: View {")
        #expect(overlays.contains("let inset: CGFloat = density == .dense ? 4 : 8"))
        #expect(overlays.contains("TileNamePill(model: model, speaking: speaking, density: density) .padding(inset)"))
        #expect(overlays.contains(".dynamicTypeSize(...DynamicTypeSize.xxxLarge)"))
        let namePill = try section(iosTile, from: "private struct TileNamePill: View {", to: "private struct PillWaveform: View {")
        #expect(namePill.contains(".font(density == .dense ? .caption2 : .footnote)"))
        #expect(namePill.contains(".padding(.horizontal, 8) .padding(.vertical, 4)"))
    }

    static let androidLandscape = StageViewport(width: 914.3, height: 411.4, insetTop: 84.2, insetBottom: 100.2, insetLeading: 0,
                                                insetTrailing: 0, widthClass: StageSizeClass.expanded, heightClass: StageSizeClass.compact,
                                                placement: .bottomBar)
    static let androidSafeBottom = 24.2
    static let androidCutoutLandscape = StageViewport(width: 914.3, height: 411.4, insetTop: 84.2, insetBottom: 100.2, insetLeading: 32,
                                                      insetTrailing: 0, widthClass: StageSizeClass.expanded,
                                                      heightClass: StageSizeClass.compact, placement: .bottomBar)
    static let androidGestureLandscape = StageViewport(width: 892, height: 412, insetTop: 84, insetBottom: 100, insetLeading: 0,
                                                       insetTrailing: 0, widthClass: StageSizeClass.expanded,
                                                       heightClass: StageSizeClass.compact, placement: .bottomBar)
    static let androidShortLandscape = StageViewport(width: 800, height: 360, insetTop: 84, insetBottom: 100, insetLeading: 0,
                                                     insetTrailing: 0, widthClass: StageSizeClass.medium, heightClass: StageSizeClass.compact,
                                                     placement: .bottomBar)
    static let androidGestureSafeBottom = 24.0
    static let iosLandscape = StageViewportPolicy.iOS(contentWidth: 750, contentHeight: 369,
                                                      safeArea: StageChromeInsets(top: 0, bottom: 21, leading: 47, trailing: 47),
                                                      regularWidth: false, compactHeight: true, topReserve: 56, barReserve: 64,
                                                      trailingReserve: 64)
    static let iosSafeBottom = 21.0

    private func burstStage(_ viewport: StageViewport, count: Int = 6) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(viewport)
        stage.apply(count == 6 ? StageFixtureScript.inputs(for: .reactionsBurst25) : StageFixtureScript.base(count: count))
        return stage
    }

    private func androidMetrics(fontScale: Double, viewport: StageViewport = S1bStageMomentsTests.androidLandscape,
                                safeBottom: Double = S1bStageMomentsTests.androidSafeBottom) -> StageReactionSlotMetrics {
        StageReactionSlotMetrics(
            defaultBottomInset: StageReactionPolicy.layerBottomInset(barReserve: 76, labelLineHeight: 16 * fontScale, defaultLabelLineHeight: 16),
            layerLeading: viewport.insetLeading, layerBottom: safeBottom,
            slotHeight: StageReactionPolicy.reducedSlotHeight(pillLineHeight: 16 * min(fontScale, StageReactionPolicy.reducedPillMaxFontScale)),
            labelBand: StageReactionPolicy.tileLabelBand(lineHeight: 16 * fontScale), barMaxWidth: ControlBarPolicy.androidMaxToolbarWidth)
    }

    private func iosMetrics(tileLine: Double, pillLine: Double) -> StageReactionSlotMetrics {
        StageReactionSlotMetrics(
            defaultBottomInset: StageReactionPolicy.layerBottomInset(barReserve: 64, labelLineHeight: tileLine, defaultLabelLineHeight: 15.5),
            layerLeading: Self.iosLandscape.insetLeading, layerBottom: Self.iosSafeBottom,
            slotHeight: StageReactionPolicy.reducedSlotHeight(pillLineHeight: pillLine),
            labelBand: StageReactionPolicy.tileLabelBand(lineHeight: tileLine), barMaxWidth: 0)
    }

    private func slotRects(_ placement: StageReactionSlotPlacement, viewport: StageViewport, metrics: StageReactionSlotMetrics) -> [StageFrame] {
        let bottom = viewport.height - metrics.layerBottom - placement.bottomInset
        var rects: [StageFrame] = []
        for lane in 0..<StageReactionPolicy.laneCount {
            let x = metrics.layerLeading + StageReactionPolicy.leadingInset
                + StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: true, shape: placement.shape)
            let lift = StageReactionPolicy.slotOffsetY(lane: lane, shape: placement.shape, slotHeight: metrics.slotHeight)
            rects.append(StageFrame(slotId: "slot" + String(lane), x: x, y: bottom - lift - metrics.slotHeight,
                                    width: StageReactionPolicy.reducedSlotWidth, height: metrics.slotHeight))
        }
        return rects
    }

    private func tileLabels(viewport: StageViewport, layout: StageLayoutSnapshot, frames: [StageFrame], line: Double) -> [StageFrame] {
        var labels: [StageFrame] = []
        for slot in layout.slots where StageViewportPolicy.carriesNameTag(slot.role) {
            guard let frame = StageLayoutPolicy.find(slot.id, in: frames) else { continue }
            let insets = StageViewportPolicy.tileInsets(kind: layout.kind, role: slot.role, viewport: viewport)
            let height = 2 * 4.0 + max(16.0, line)
            for inset in [8.0, 4.0] {
                let bottom = frame.maxY - insets.bottom - inset
                labels.append(StageFrame(slotId: slot.id, x: frame.x + insets.leading + inset, y: bottom - height,
                                         width: frame.width - insets.leading - insets.trailing - 2 * inset, height: height))
            }
        }
        return labels
    }

    private func coveredArea(_ rects: [StageFrame], labels: [StageFrame]) -> Double {
        var total = 0.0
        for rect in rects {
            for label in labels {
                let width = min(rect.maxX, label.maxX) - max(rect.x, label.x)
                let height = min(rect.maxY, label.maxY) - max(rect.y, label.y)
                if width > 0 && height > 0 { total += width * height }
            }
        }
        return total
    }

    private func expectClear(viewport: StageViewport, layout: StageLayoutSnapshot, frames: [StageFrame], metrics: StageReactionSlotMetrics,
                             line: Double, _ name: String) -> StageReactionSlotPlacement {
        let placement = StageReactionPolicy.reducedPlacement(viewport: viewport, kind: layout.kind, slots: layout.slots, frames: frames,
                                                             metrics: metrics)
        let labels = tileLabels(viewport: viewport, layout: layout, frames: frames, line: line)
        #expect(!labels.isEmpty, "\(name)")
        for rect in slotRects(placement, viewport: viewport, metrics: metrics) {
            for label in labels {
                #expect(!StageLayoutPolicy.overlaps(rect, label), "\(name) \(rect.slotId) covers the \(label.slotId) label")
            }
            #expect(rect.y >= viewport.insetTop - 0.001, "\(name) \(rect.slotId) rises into the top chrome")
            #expect(rect.maxY <= viewport.height - metrics.layerBottom + 0.001, "\(name) \(rect.slotId) leaves the layer")
            #expect(rect.x >= viewport.insetLeading + StageReactionPolicy.leadingInset - 0.001, "\(name) \(rect.slotId) leaves the safe area")
        }
        return placement
    }

    private func expectClear(_ stage: StagePresenter, metrics: StageReactionSlotMetrics, line: Double, _ name: String) -> StageReactionSlotPlacement {
        expectClear(viewport: stage.viewport, layout: stage.layout, frames: stage.currentFrames(), metrics: metrics, line: line, name)
    }

    @Test func reducedSlotsNeverSitOverATileLabelInATwoByThreeLandscapeGrid() {
        let android = burstStage(Self.androidLandscape)
        let frames = android.currentFrames()
        #expect(android.layout.kind == .grid && frames.count == 6)
        #expect(Set(frames.map { Int($0.x.rounded()) }).count == 3 && Set(frames.map { Int($0.y.rounded()) }).count == 2)

        let androidDefault = expectClear(android, metrics: androidMetrics(fontScale: 1.0), line: 16, "android default")
        #expect(androidDefault.shape == .column)
        #expect(abs(androidDefault.bottomInset - 71.0) < 0.01)
        let androidLarge = expectClear(android, metrics: androidMetrics(fontScale: 2.0), line: 32, "android font 2.0")
        #expect(androidLarge.shape == .column)
        #expect(abs(androidLarge.bottomInset - 47.0) < 0.01)
        for placement in [androidDefault, androidLarge] {
            let column = slotRects(placement, viewport: Self.androidLandscape, metrics: androidMetrics(fontScale: 1.0))
            for rect in column {
                #expect(frames.allSatisfy { rect.maxX <= $0.x }, "the stacked slots stay in the margin beside the grid")
            }
        }

        let ios = burstStage(Self.iosLandscape)
        #expect(ios.layout.kind == .grid && ios.currentFrames().count == 6)
        let iosDefault = expectClear(ios, metrics: iosMetrics(tileLine: 15.5, pillLine: 13.13), line: 15.5, "ios default")
        #expect(iosDefault.shape == .row && iosDefault.bottomInset != 128)
        let iosLarge = expectClear(ios, metrics: iosMetrics(tileLine: 22.7, pillLine: 20.29), line: 22.7, "ios AX5")
        #expect(iosLarge.shape == .row && abs(iosLarge.bottomInset - 135.2) > 1)
    }

    @Test func whenNeitherARowNorAColumnClearsTheLabelsTheSlotsTakeAMarginBlock() {
        let viewport = Self.androidGestureLandscape
        let stage = burstStage(viewport, count: 7)
        let frames = stage.currentFrames()
        #expect(stage.layout.kind == .grid && frames.count == 7)
        #expect(Set(frames.map { Int($0.y.rounded()) }).count == 2)
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale, viewport: viewport, safeBottom: Self.androidGestureSafeBottom)
            let resting = StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row)
            let labels = tileLabels(viewport: viewport, layout: stage.layout, frames: frames, line: 16 * scale)
            #expect(coveredArea(slotRects(resting, viewport: viewport, metrics: metrics), labels: labels) > 0,
                    "the 2c060c7a row covers a label here at font \(scale)")
            let placement = expectClear(stage, metrics: metrics, line: 16 * scale, "seven tiles font \(scale)")
            #expect(placement.shape == .block, "font \(scale)")
            #expect(abs(placement.bottomInset - (scale == 1.0 ? 34.0 : 18.0)) < 0.01, "font \(scale)")
        }
    }

    @Test func whenNothingClearsTheSlotsTakeTheLeastCoveredPlaceNotTheRestingRow() {
        let viewport = Self.androidGestureLandscape
        let stage = burstStage(viewport, count: 8)
        let frames = stage.currentFrames()
        #expect(stage.layout.kind == .grid && frames.count == 8)
        let metrics = androidMetrics(fontScale: 2.0, viewport: viewport, safeBottom: Self.androidGestureSafeBottom)
        let resting = StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row)
        let placement = StageReactionPolicy.reducedPlacement(viewport: viewport, kind: stage.layout.kind, slots: stage.layout.slots,
                                                             frames: frames, metrics: metrics)
        #expect(placement != resting)
        let labels = tileLabels(viewport: viewport, layout: stage.layout, frames: frames, line: 32)
        let restingCover = coveredArea(slotRects(resting, viewport: viewport, metrics: metrics), labels: labels)
        let placedCover = coveredArea(slotRects(placement, viewport: viewport, metrics: metrics), labels: labels)
        #expect(placedCover < restingCover / 10, "covered \(placedCover) against \(restingCover) at rest")
        for rect in slotRects(placement, viewport: viewport, metrics: metrics) {
            #expect(rect.y >= viewport.insetTop - 0.001 && rect.maxY <= viewport.height - metrics.layerBottom + 0.001)
        }
    }

    @Test func theShortLandscapePhoneKeepsOneRowOfTilesAndTheSlotsClearItsLabels() {
        let viewport = Self.androidShortLandscape
        let stage = burstStage(viewport)
        let frames = stage.currentFrames()
        #expect(stage.layout.kind == .grid && frames.count == 4)
        #expect(stage.layout.slots.contains { $0.role == .overflow })
        #expect(Set(frames.map { Int($0.y.rounded()) }).count == 1)
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale, viewport: viewport, safeBottom: Self.androidGestureSafeBottom)
            let placement = expectClear(stage, metrics: metrics, line: 16 * scale, "800 by 360 font \(scale)")
            #expect(placement.shape == .row, "font \(scale)")
        }
    }

    @Test func aLeadingCutoutMovesTheSlotsWithTheGrid() {
        let viewport = Self.androidCutoutLandscape
        let stage = burstStage(viewport)
        let frames = stage.currentFrames()
        #expect(frames.count == 6 && frames.allSatisfy { $0.x >= viewport.insetLeading })
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale, viewport: viewport)
            #expect(metrics.layerLeading == 32)
            let placement = expectClear(stage, metrics: metrics, line: 16 * scale, "cutout font \(scale)")
            #expect(placement.shape == .column, "font \(scale)")
            for rect in slotRects(placement, viewport: viewport, metrics: metrics) {
                #expect(abs(rect.x - 44) < 0.001, "the column starts at the cutout plus 12")
            }
        }
    }

    @Test func aRotationWithTheSameSlotsPlacesTheSlotsFromTheLayersOwnLandscapeGeometry() throws {
        let portrait = StageViewport(width: 411.4, height: 914.3, insetTop: 84.2, insetBottom: 100.2, insetLeading: 0, insetTrailing: 0,
                                     widthClass: StageSizeClass.compact, heightClass: StageSizeClass.medium, placement: .bottomBar)
        let stage = burstStage(portrait)
        let layout = stage.layout
        #expect(layout.kind == .grid && layout.slots.count == 6)
        let metrics = androidMetrics(fontScale: 1.0)
        let stale = StageReactionPolicy.reducedPlacement(viewport: stage.viewport, kind: layout.kind, slots: layout.slots,
                                                         frames: stage.currentFrames(), metrics: metrics)
        #expect(stale == StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row))
        let landscapeFrames = StageLayoutPolicy.frames(viewport: Self.androidLandscape, kind: layout.kind, slots: layout.slots,
                                                       selfCorner: layout.selfCorner)
        let labels = tileLabels(viewport: Self.androidLandscape, layout: layout, frames: landscapeFrames, line: 16)
        #expect(coveredArea(slotRects(stale, viewport: Self.androidLandscape, metrics: metrics), labels: labels) > 0,
                "the portrait placement would cover a label after the rotation")
        let rotated = expectClear(viewport: Self.androidLandscape, layout: layout, frames: landscapeFrames, metrics: metrics, line: 16, "rotated")
        #expect(rotated.shape == .column)

        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        let kotlin = stageNormalized(try stageSource(Self.androidReactionsFile))
        for (name, text) in [("ios", ios), ("android", kotlin)] {
            #expect(!text.contains("stage.viewport") && !text.contains("stage.currentFrames()"), "\(name) reads the presenter's stored viewport")
        }
        let iosCanvas = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageCanvas+iOS.swift"))
        let iosShared = "regularWidth: horizontalSizeClass == .regular, compactHeight: verticalSizeClass == .compact, topReserve: Double(StageCanvasMetrics.topReserve), barReserve: Double(StageCanvasMetrics.barReserve), trailingReserve: Double(StageCanvasMetrics.trailingReserve), chipRowReserve: stage.chipRowVisible ? Double(StageCanvasMetrics.chipRowReserve) : 0 )"
        #expect(iosCanvas.contains(iosShared) && ios.contains(iosShared))
        #expect(ios.contains(".onGeometryChange(for: ReactionLayerGeometry.self) { proxy in ReactionLayerGeometry(width: Double(proxy.size.width), height: Double(proxy.size.height), top: Double(proxy.safeAreaInsets.top), bottom: Double(proxy.safeAreaInsets.bottom), leading: Double(proxy.safeAreaInsets.leading), trailing: Double(proxy.safeAreaInsets.trailing)) } action: { next in if next != layer { layer = next } }"))
        #expect(ios.contains("contentWidth: layer.width, contentHeight: layer.height, safeArea: StageChromeInsets(top: layer.top, bottom: layer.bottom, leading: layer.leading, trailing: layer.trailing),"))
        #expect(ios.contains("let frames = StageLayoutPolicy.frames(viewport: viewport, kind: layout.kind, slots: layout.slots, selfCorner: layout.selfCorner)"))
        let androidCanvas = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/StageCanvas.kt"))
        for shared in ["val left = insets.getLeft(density, direction) / scale val right = insets.getRight(density, direction) / scale",
                       "width = maxWidth.value.toDouble(), height = maxHeight.value.toDouble(), top = insets.getTop(density) / scale,",
                       "leading = if (direction == LayoutDirection.Ltr) left else right, trailing = if (direction == LayoutDirection.Ltr) right else left, chipRow = if (stage.chipRowVisible) StageViewportPolicy.androidChipRowReserve else 0.0, )"] {
            #expect(androidCanvas.contains(shared) && kotlin.contains(shared), "\(shared)")
        }
        #expect(kotlin.contains("val frames = StageLayoutPolicy.frames(viewport = viewport, kind = layout.kind, slots = layout.slots, selfCorner = layout.selfCorner)"))
        for name in ["foundation.layout.BoxWithConstraints", "ui.platform.LocalLayoutDirection", "ui.unit.LayoutDirection"] {
            #expect(kotlin.contains("import androidx.compose.\(name) "), "Reactions.kt lacks the \(name) import")
        }
    }

    @Test func portraitAndClearLandscapeStagesKeepTheRestingReducedLayer() {
        let portrait = StageViewport(width: 411.4, height: 914.3, insetTop: 84.2, insetBottom: 100.2, insetLeading: 0, insetTrailing: 0,
                                     widthClass: StageSizeClass.compact, heightClass: StageSizeClass.medium, placement: .bottomBar)
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale)
            let stage = burstStage(portrait)
            let placement = StageReactionPolicy.reducedPlacement(viewport: portrait, kind: stage.layout.kind, slots: stage.layout.slots,
                                                                 frames: stage.currentFrames(), metrics: metrics)
            #expect(placement == StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row), "portrait \(scale)")
        }
        let empty = StageReactionPolicy.reducedPlacement(viewport: .zero, kind: .grid, slots: [], frames: [], metrics: androidMetrics(fontScale: 1.0))
        #expect(empty == StageReactionSlotPlacement(bottomInset: 140, shape: .row))

        let oneOnOne = burstStage(Self.androidLandscape, count: 2)
        #expect(oneOnOne.layout.kind == .oneOnOne)
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale)
            let placement = expectClear(oneOnOne, metrics: metrics, line: 16 * scale, "android one on one \(scale)")
            #expect(placement == StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row))
        }
        let iosOneOnOne = burstStage(Self.iosLandscape, count: 2)
        let iosPlacement = expectClear(iosOneOnOne, metrics: iosMetrics(tileLine: 22.7, pillLine: 20.29), line: 22.7, "ios one on one")
        #expect(iosPlacement == StageReactionSlotPlacement(bottomInset: 135.2, shape: .row))
    }

    @Test func theReducedSlotGeometryMirrorsTheRenderedBubbleAndTileLabel() throws {
        #expect(StageReactionPolicy.reducedSlotGap == StageReactionPolicy.reducedLaneOffset - StageReactionPolicy.reducedSlotWidth)
        #expect(StageReactionPolicy.reducedSlotHeight(pillLineHeight: 16) == 72)
        #expect(StageReactionPolicy.reducedSlotHeight(pillLineHeight: 24) == 80)
        #expect(StageReactionPolicy.tileLabelBand(lineHeight: 16) == 32)
        #expect(StageReactionPolicy.tileLabelBand(lineHeight: 32) == 48)
        #expect(StageReactionPolicy.tileLabelBand(lineHeight: 15.5) == 32)
        #expect(StageReactionPolicy.labelClearance == 8)
        #expect(StageReactionPolicy.reducedShapes == [.row, .column, .block])
        #expect(StageReactionPolicy.shapeWidth(.row) == 208 && StageReactionPolicy.shapeWidth(.column) == 64
                && StageReactionPolicy.shapeWidth(.block) == 136)
        #expect(StageReactionPolicy.shapeHeight(.row, slotHeight: 72) == 72 && StageReactionPolicy.shapeHeight(.column, slotHeight: 72) == 232
                && StageReactionPolicy.shapeHeight(.block, slotHeight: 72) == 152)
        let blockX: [Double] = [0, 72, 0]
        let blockY: [Double] = [0, 0, 80]
        for lane in 0..<StageReactionPolicy.laneCount {
            for shape in StageReactionSlotShape.allCases {
                #expect(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: false, shape: shape) == Double(lane) * StageReactionPolicy.laneOffset)
            }
            #expect(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: true, shape: .row) == Double(lane) * StageReactionPolicy.reducedLaneOffset)
            #expect(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: true, shape: .column) == 0)
            #expect(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: true, shape: .block) == blockX[lane])
            #expect(StageReactionPolicy.slotOffsetY(lane: lane, shape: .row, slotHeight: 72) == 0)
            #expect(StageReactionPolicy.slotOffsetY(lane: lane, shape: .column, slotHeight: 72) == Double(lane) * 80)
            #expect(StageReactionPolicy.slotOffsetY(lane: lane, shape: .block, slotHeight: 72) == blockY[lane])
        }
        for shape in StageReactionSlotShape.allCases {
            let rects = slotRects(StageReactionSlotPlacement(bottomInset: 0, shape: shape), viewport: Self.androidLandscape,
                                  metrics: androidMetrics(fontScale: 1.0))
            for first in 0..<rects.count {
                for second in (first + 1)..<rects.count {
                    #expect(!StageLayoutPolicy.overlaps(rects[first], rects[second]), "\(shape) lanes \(first) and \(second) overlap")
                }
            }
        }

        let ios = stageNormalized(try stageSource(Self.iosReactionsFile))
        #expect(ios.contains("VStack(spacing: 4) {"))
        #expect(ios.contains(".font(.caption2) .lineLimit(1) .padding(.horizontal, 6) .padding(.vertical, 2)"))
        #expect(ios.contains("let tileLine = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: cappedTraits).lineHeight"))
        #expect(ios.contains("let pillLine = UIFont.preferredFont(forTextStyle: .caption2, compatibleWith: cappedTraits).lineHeight"))
        #expect(ios.contains("viewport: viewport, safeBottom: layer.bottom)"))
        #expect(ios.contains("barMaxWidth: StageLayoutPolicy.isCompactHeight(viewport) ? 0.0 : viewport.width)"))
        #expect(ios.contains("return StageReactionPolicy.reducedPlacement(viewport: viewport, kind: layout.kind, slots: layout.slots, frames: frames, metrics: metrics)"))
        #expect(ios.contains("ReactionBubble(event: event, reduceMotion: reduceMotion, slotShape: placement.shape, slotHeight: slots.slotHeight)"))
        #expect(count("reducedPlacement(", in: ios) == 1)

        let kotlin = stageNormalized(try stageSource(Self.androidReactionsFile))
        #expect(kotlin.contains("verticalArrangement = Arrangement.spacedBy(4.dp),"))
        #expect(kotlin.contains("modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)"))
        #expect(kotlin.contains("val pillLine = MaterialTheme.typography.labelSmall.lineHeight.value.toDouble() * minOf(fontScale, StageReactionPolicy.reducedPillMaxFontScale)"))
        #expect(kotlin.contains("val safeBottom = insets.getBottom(density) / scale"))
        #expect(kotlin.contains("StageReactionSlotMetrics(defaultBottomInset = bottomInset, layerLeading = viewport.insetLeading, layerBottom = safeBottom,"))
        #expect(kotlin.contains("labelBand = StageReactionPolicy.tileLabelBand(lineHeight = tileLabelLine * fontScale), barMaxWidth = ControlBarPolicy.androidMaxToolbarWidth)"))
        #expect(kotlin.contains("StageReactionPolicy.reducedPlacement(viewport = viewport, kind = layout.kind, slots = layout.slots, frames = frames, metrics = metrics)"))
        #expect(kotlin.contains("key(event.id) { ReactionBubble(event, reduceMotion, placement.shape, slotHeight) }"))
        #expect(kotlin.contains("private fun ReactionBubble(event: ReactionEvent, reduceMotion: Boolean, slotShape: StageReactionSlotShape, slotHeight: Double) {"))
        #expect(count("reducedPlacement(", in: kotlin) == 1)

        let policy = stageNormalized(try stageSource(Self.policyFile))
        #expect(policy.contains("enum StageReactionSlotShape: String, CaseIterable, Equatable { case row, column, block }"))
        #expect(policy.contains("if viewport.isEmpty || !viewport.isLandscape { return resting }"))
        #expect(policy.contains("if !slotsCollide(restingFrames, bands: bands) { return resting }"))
        #expect(policy.contains("if clearY >= 0.0 { return StageReactionSlotPlacement(bottomInset: layerBottomY - clearY, shape: shape) } } return fallback }"))
        let androidBar = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/controls/CallControlBar.kt"))
        #expect(androidBar.contains("modifier = Modifier.widthIn(max = ControlBarPolicy.androidMaxToolbarWidth.dp),"))
    }
}
#endif
