#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// T3B-1 (R/t3-borrow/PLAN.md section 4): the composer components after the T3 Code borrow. P5 the one-row composer
/// geometry, P9 the opt-in counter bands, and the component halves of P1, P2, P4 and P6 (the Android hardware-key hook,
/// held Enter, the TextFieldState overload and the disabled Send reason). Patterns only; no T3 code. iOS-only and
/// Kotlin sources are not compiled by this macOS host, so their rules are read from the sources; the Kotlin helpers run
/// in T/Skip/T3BorrowComposerFieldTests.kt.
struct T3BorrowComposerComponentTests {
    static let glassFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveComposerGlass+iOS.swift"
    static let fieldsFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift"
    static let modelsFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveContentModels.swift"
    static let kotlinFile = "Sources/Conclave/Skip/ui/components/ConclaveFields.kt"

    // MARK: P9 counter bands (shared policy)

    @Test func counterBandsFollowTheLimit() {
        let from = ConclaveComposerCounterPolicy.visibleFrom(limit: 1000)
        #expect(from == 900)
        #expect(ConclaveComposerCounterPolicy.band(count: 0, limit: 1000, visibleFrom: from) == .hidden)
        #expect(ConclaveComposerCounterPolicy.band(count: 899, limit: 1000, visibleFrom: from) == .hidden)
        #expect(ConclaveComposerCounterPolicy.band(count: 900, limit: 1000, visibleFrom: from) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 1000, limit: 1000, visibleFrom: from) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 1001, limit: 1000, visibleFrom: from) == .over)
        #expect(ConclaveComposerCounterPolicy.band(count: 1200, limit: 1000, visibleFrom: from) == .over)
        // Voice mode passes visibleFrom 0, so the counter always shows (S40 6 f).
        #expect(ConclaveComposerCounterPolicy.band(count: 0, limit: 500, visibleFrom: 0) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 501, limit: 500, visibleFrom: 0) == .over)
        // The S10 display-name counter (cap 40, visible from 30) is unchanged: the band is hidden exactly where the
        // counter was not drawn before (count below visibleFrom), for every caller.
        for limit in [40, 500, 1000] {
            for visibleFrom in [0, 30, ConclaveComposerCounterPolicy.visibleFrom(limit: limit)] {
                for count in stride(from: 0, through: limit + 20, by: 1) {
                    let band = ConclaveComposerCounterPolicy.band(count: count, limit: limit, visibleFrom: visibleFrom)
                    #expect((band != .hidden) == (count >= visibleFrom), "\(count) of \(limit) from \(visibleFrom)")
                    if band != .hidden {
                        #expect((band == .over) == (ConclaveComposerCounterPolicy.overflow(count: count, limit: limit) > 0))
                    }
                }
            }
        }
        #expect(ConclaveCounterBand.allCases.map { $0.rawValue } == ["hidden", "near", "over"])
    }

    @Test func counterAnnouncesOnceAtEachCrossing() {
        // R5: a 1,200-character paste speaks once (hidden to over), more typing never speaks, dropping under the limit
        // speaks once (over to near), and going back under 90% is silent. The Android announcer runs exactly this
        // decision on the band it last saw (pinned in androidCounterSpeaksOncePerCrossing); the iOS handler restarts
        // with the band (`task(id: band)`), which matches it while the counter stays on screen (deviation 7.2: iOS
        // also speaks when the counter reappears in a band, for example after the GIF page pops).
        let expected: [String: Bool] = [
            "hidden>hidden": false, "hidden>near": true, "hidden>over": true,
            "near>hidden": false, "near>near": false, "near>over": true,
            "over>hidden": false, "over>near": true, "over>over": false,
        ]
        for previous in ConclaveCounterBand.allCases {
            for next in ConclaveCounterBand.allCases {
                let key = previous.rawValue + ">" + next.rawValue
                #expect(ConclaveComposerCounterPolicy.announces(previous: previous, next: next) == expected[key], "\(key)")
            }
        }
        // A typing run: 1,200 pasted, 1,250 typed, 999 after deleting, 899 after deleting more.
        var previous = ConclaveCounterBand.hidden
        var spoken: [String] = []
        for count in [0, 1200, 1210, 1250, 999, 950, 899, 0] {
            let next = ConclaveComposerCounterPolicy.band(count: count, limit: 1000, visibleFrom: 900)
            if ConclaveComposerCounterPolicy.announces(previous: previous, next: next) { spoken.append(next.rawValue) }
            previous = next
        }
        #expect(spoken == ["over", "near"])
    }

    // MARK: P5 geometry

    @Test func composerRowIsOne44PointRow() throws {
        #expect(ConclaveComposerMetrics.fieldTrailingGap == 4)
        #expect(ConclaveComposerMetrics.minimumFieldHeight == ConclaveComposerMetrics.attachDiameter)
        // The 22 pt radius is half the row, so the Send glyph circle in its 44 pt target is concentric with the trailing
        // corner; the Send target reuses the 44 pt button metric (no new sendTarget metric).
        #expect(ConclaveComposerMetrics.glassCornerRadius * 2 == ConclaveComposerMetrics.minimumFieldHeight)
        let buttons = t3cNormalized(try t3cSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveButtons+iOS.swift"))
        #expect(buttons.contains("static let minimumHeight: CGFloat = 44"))
        let fields = t3cNormalized(try t3cSource(Self.fieldsFile))
        #expect(fields.contains(".frame(minWidth: ConclaveButtonMetrics.minimumHeight, minHeight: ConclaveButtonMetrics.minimumHeight)"))

        let code = t3cWithoutComments(try t3cSource(Self.glassFile))
        let blocks = t3cBracedBlocks(after: "private var fieldContainer: some View {", in: code)
        #expect(blocks.count == 1)
        guard let block = blocks.first else { return }
        let container = String(code[block])
        let flat = t3cNormalized(container)
        // The field carries the 12 by 8 padding and the 44 pt minimum with .leading (vertically centred); Send follows
        // with no padding of its own, and the row keeps its 44 pt minimum. Bottom alignment keeps Send on the last line.
        #expect(flat.contains("HStack(alignment: .bottom, spacing: 0) {"))
        #expect(flat.contains("field .padding(.vertical, CGFloat(ConclaveComposerMetrics.fieldVerticalPadding)) .frame(maxWidth: .infinity, minHeight: CGFloat(ConclaveComposerMetrics.minimumFieldHeight), alignment: .leading)"))
        #expect(flat.contains(".padding(.leading, CGFloat(ConclaveComposerMetrics.fieldHorizontalPadding)) .padding(.trailing, CGFloat(ConclaveComposerMetrics.fieldTrailingGap)) send }"))
        #expect(flat.hasSuffix("} .frame(minHeight: CGFloat(ConclaveComposerMetrics.minimumFieldHeight)) }"))
        let afterSend = container.components(separatedBy: "send\n").dropFirst().joined(separator: "send\n")
        #expect(!afterSend.contains(".padding("), "Send is never padded")
        #expect(container.components(separatedBy: ".padding(.vertical").count - 1 == 1, "only the field is padded vertically")
        // The old container padding (which wrapped Send too) is gone everywhere in the file.
        #expect(!t3cNormalized(code).contains(".padding(.horizontal, CGFloat(ConclaveComposerMetrics.fieldHorizontalPadding))"))
        // Both material branches draw the one container; the glass shape count is unchanged (two calls, one interactive).
        #expect(code.components(separatedBy: "fieldContainer").count - 1 == 3)
        #expect(code.components(separatedBy: ".glassEffect(").count - 1 == 2)
        #expect(code.components(separatedBy: "GlassEffectContainer(").count - 1 == 1)
        #expect(code.components(separatedBy: ".interactive(").count - 1 == 1)
    }

    @Test func androidAttachCentresOnTheOneLineHeight() throws {
        let android = t3cNormalized(try t3cSource(Self.kotlinFile))
        #expect(android.contains("Box(Modifier.heightIn(min = TextFieldDefaults.MinHeight), contentAlignment = Alignment.Center) { attach() }"))
        #expect(android.components(separatedBy: "if (attach != null) ConclaveComposerAttachSlot(attach)").count - 1 == 2)
        #expect(!android.contains("if (attach != null) attach()"))
        // Owner polish keeps native trailing text space, with Send in the last-line band as the field grows.
        #expect(android.components(separatedBy: "trailingIcon = { Spacer(Modifier.size(48.dp)) },").count - 1 == 2)
        #expect(android.components(separatedBy: "ConclaveComposerSendSlot(Modifier.align(Alignment.BottomEnd)) { ConclaveComposerSend(identifier, sendEnabled, onSend, sendLabel, sendDisabledReason) }").count - 1 == 2)
    }

    // MARK: P1, P2, P4 and P6 component halves (Android)

    @Test func kotlinComposerOverloadsMatchTheContracts() throws {
        let android = t3cNormalized(try t3cSource(Self.kotlinFile))
        // The value overload gains the reason and the hardware-key hook before attach; its callers use named arguments.
        #expect(android.contains("placeholder: String, value: String, onValueChange: (String) -> Unit, sendEnabled: Boolean, onSend: () -> Unit, identifier: String, modifier: Modifier = Modifier, sendLabel: String? = null, enabled: Boolean = true, sendDisabledReason: String = \"\", onHardwareKey: ((KeyEvent) -> Boolean)? = null, fieldModifier: Modifier = Modifier, attach: (@Composable () -> Unit)? = null,"))
        // The TextFieldState overload, as the plan's contract lists it plus the fix-pass amendments (onSendBlocked for
        // P6, fieldModifier for P3 and P8), both defaulted and before attach, so named callers are unaffected.
        #expect(android.contains("placeholder: String, state: TextFieldState, sendEnabled: Boolean, onSend: () -> Unit, identifier: String, modifier: Modifier = Modifier, sendLabel: String? = null, sendDisabledReason: String = \"\", enabled: Boolean = true, onHardwareKey: ((KeyEvent) -> Boolean)? = null, onSendBlocked: (() -> Unit)? = null, fieldModifier: Modifier = Modifier, attach: (@Composable () -> Unit)? = null,"))
        // fieldModifier lands on the TextField (a FocusRequester there reaches the field, not the attach button).
        #expect(android.components(separatedBy: "modifier = Modifier.fillMaxWidth().then(fieldModifier).testTag(identifier).onPreviewKeyEvent { event ->").count - 1 == 2)
        #expect(android.components(separatedBy: "Row(modifier.fillMaxWidth(),").count - 1 == 2)
        #expect(android.contains("import androidx.compose.ui.input.key.KeyEvent"))
        #expect(android.contains("import androidx.compose.foundation.text.input.TextFieldState"))
        #expect(android.contains("TextField( state = state,"))
        #expect(android.contains("lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = 6),"))
        // Q13 unchanged: IME Send calls onSend only while Send is enabled, on both overloads; a blocked IME Send on the
        // state overload goes to onSendBlocked (P6), never to onSend.
        #expect(android.contains("onKeyboardAction = conclaveComposerImeSend(sendEnabled, onSendBlocked, onSend),"))
        #expect(android.contains("KeyboardActionHandler { if (sendEnabled) onSend() else onSendBlocked?.invoke() }"))
        #expect(android.contains("sendEnabled: Boolean, onSendBlocked: (() -> Unit)? = null, onSend: () -> Unit, ): KeyboardActionHandler"))
        #expect(android.contains("keyboardActions = KeyboardActions(onSend = { if (sendEnabled) onSend() }),"))
        #expect(android.components(separatedBy: "imeAction = ImeAction.Send),").count - 1 == 2)
        // FND-1 pins stay (FND1FoundationPackTests runs unedited).
        #expect(android.contains("event.key == Key.Enter && !event.isShiftPressed"))
        #expect(android.contains("maxLines = 6"))
        #expect(android.contains("Icon(ConclaveIcons.SendFill1, contentDescription = conclaveString(\"ds_send\"),"))
        #expect(!android.contains("onImeSend"))
    }

    @Test func kotlinHardwareKeysRunFirstAndHeldEnterSendsOnce() throws {
        let android = t3cNormalized(try t3cSource(Self.kotlinFile))
        #expect(android.components(separatedBy: "onPreviewKeyEvent { event -> conclaveComposerKey(event, sendEnabled, onSend, onHardwareKey) }").count - 1 == 2)
        let lower = try #require(android.range(of: "internal fun conclaveComposerKey("))
        let upper = try #require(android.range(of: "internal fun conclaveComposerImeSend(", range: lower.upperBound..<android.endIndex))
        let body = String(android[lower.upperBound..<upper.lowerBound])
        let hook = try #require(body.range(of: "if (onHardwareKey != null && onHardwareKey(event)) return true"))
        let keyDown = try #require(body.range(of: "if (event.type != KeyEventType.KeyDown) return false"))
        let enter = try #require(body.range(of: "if (event.key == Key.Enter && !event.isShiftPressed) {"))
        let numPad = try #require(body.range(of: "if (event.key == Key.NumPadEnter && !event.isShiftPressed) {"))
        // The screen's keys run first (on KeyDown and KeyUp), then the Enter branches on KeyDown only.
        #expect(hook.upperBound <= keyDown.lowerBound && keyDown.upperBound <= enter.lowerBound && enter.upperBound <= numPad.lowerBound)
        // An auto-repeat is consumed without sending; both branches return true.
        #expect(body.components(separatedBy: "if (event.nativeKeyEvent.repeatCount == 0 && sendEnabled) onSend() return true").count - 1 == 2)
    }

    @Test func kotlinDisabledSendCarriesItsReason() throws {
        let android = t3cNormalized(try t3cSource(Self.kotlinFile))
        #expect(android.contains("import androidx.compose.ui.semantics.stateDescription"))
        #expect(android.contains("val stateText = conclaveSendStateDescription(sendEnabled, reason)"))
        #expect(android.contains("IconButton(onClick = onSend, enabled = sendEnabled, modifier = Modifier.testTag(\"$identifier.send\").semantics { if (stateText != null) stateDescription = stateText })"))
        #expect(android.contains("if (!sendEnabled && reason.isNotEmpty()) reason else null"))
        // The FND-3 pins on Send and the container colors stay.
        #expect(android.contains("scheme.onSurface.copy(alpha = ConclaveDisabledOpacity.android.toFloat())"))
        #expect(android.contains("Icon(ConclaveIcons.SendFill1, contentDescription = sendLabel, tint = tint)"))
        #expect(android.contains("focusedContainerColor = scheme.surfaceContainerHighest,"))
        #expect(android.contains("focusedIndicatorColor = Color.Transparent,"))
        #expect(android.components(separatedBy: "colors = conclaveComposerColors(),").count - 1 == 2)
    }

    // MARK: P9 counter announcements (opt-in)

    @Test func iosCounterPostsOnlyFromTheBandHandlerWhenOptedIn() throws {
        let text = try t3cSource(Self.fieldsFile)
        let code = t3cWithoutComments(text)
        let flat = t3cNormalized(code)
        #expect(flat.contains("init(count: Int, limit: Int, visibleFrom: Int, identifier: String, announcesBands: Bool = false) {"))
        let counter = try #require(t3cBracedBlocks(after: "struct ConclaveCharacterCounter: View {", in: code).first)
        let counterFlat = t3cNormalized(String(code[counter]))
        #expect(counterFlat.contains("let band = ConclaveComposerCounterPolicy.band(count: count, limit: limit, visibleFrom: visibleFrom) if band != .hidden {"))
        #expect(counterFlat.contains(".accessibilityLabel(ConclaveStrings.format(\"%lld of %lld Characters\", count, limit))"))
        #expect(counterFlat.contains(".modifier(ConclaveCounterBandAnnouncement(isEnabled: announcesBands, band: band, count: count, limit: limit))"))
        #expect(!counterFlat.contains(".post()"))
        let handler = try #require(t3cBracedBlocks(after: "private struct ConclaveCounterBandAnnouncement: ViewModifier {", in: code).first)
        let handlerFlat = t3cNormalized(String(code[handler]))
        // The post sits inside the band-keyed task, behind announcesBands; the task restarts only on a band change.
        #expect(handlerFlat.contains("if isEnabled { content.task(id: band) { var text = AttributedString(ConclaveCounterText.announcement(band: band, count: count, limit: limit)) text.accessibilitySpeechAnnouncementPriority = .low AccessibilityNotification.Announcement(text).post() } } else { content }"))
        // Every post in the file is either the counter's band handler or the search result announcement.
        let search = try #require(t3cBracedBlocks(after: "private struct ConclaveSearchAnnouncement: ViewModifier {", in: code).first)
        // The code outside both blocks, copied slice by slice in source order: a nested or overlapping block (an
        // unbalanced brace in a future edit) is skipped instead of trapping on a stale index in removeSubrange.
        var outside = ""
        var cursor = code.startIndex
        for range in [handler, search].sorted(by: { $0.lowerBound < $1.lowerBound }) where range.lowerBound >= cursor {
            outside += code[cursor..<range.lowerBound]
            cursor = range.upperBound
        }
        outside += code[cursor...]
        #expect(!outside.contains(".post()"))
        #expect(!outside.contains("AccessibilityNotification"))
        // The spoken copy reuses the catalog keys (no new iOS string).
        #expect(flat.contains("return ConclaveStrings.format(\"%lld characters over the limit\", ConclaveComposerCounterPolicy.overflow(count: count, limit: limit))"))
        #expect(flat.contains("return ConclaveStrings.format(\"%lld of %lld Characters\", count, limit)"))
    }

    @Test func androidCounterSpeaksOncePerCrossing() throws {
        let android = t3cNormalized(t3cWithoutComments(try t3cSource(Self.kotlinFile)))
        #expect(android.contains("count: Int, limit: Int, visibleFrom: Int, identifier: String, modifier: Modifier = Modifier, announcesBands: Boolean = false,"))
        let lower = try #require(android.range(of: "internal fun ConclaveCharacterCounter("))
        let upper = try #require(android.range(of: "private fun ConclaveCounterBandAnnouncer(", range: lower.upperBound..<android.endIndex))
        let body = String(android[lower.upperBound..<upper.lowerBound])
        // The announcer is composed before the hidden return (opted in only), so it stays composed while the counter
        // is hidden and sees hidden to near and hidden to over; it emits no layout node, so nothing moves at rest.
        #expect(body.contains("val band = ConclaveComposerCounterPolicy.band(count = count, limit = limit, visibleFrom = visibleFrom) if (announcesBands) ConclaveCounterBandAnnouncer(count, limit, band) if (band == ConclaveCounterBand.hidden) return"))
        // The visible counter is the silent counter for every caller (no live node inside it any more).
        #expect(!body.contains("liveRegion"))
        #expect(body.contains("modifier = modifier.testTag(identifier).semantics { contentDescription = description },"))
        // One post per crossing: the band last seen lives in a plain holder (never Compose state), the shared
        // ConclaveComposerCounterPolicy.announces decides, and the text is the one composed at the crossing.
        let announcer = try #require(t3cBracedBlocks(after: "private fun ConclaveCounterBandAnnouncer(count: Int, limit: Int, band: ConclaveCounterBand) {", in: android).first)
        let announcerFlat = String(android[announcer])
        #expect(announcerFlat.contains("val memory = remember { ConclaveCounterBandMemory(band) }"))
        #expect(announcerFlat.contains("SideEffect { val previous = memory.band if (previous != band) { memory.band = band if (ConclaveComposerCounterPolicy.announces(previous = previous, next = band) && spoken.isNotEmpty()) { @Suppress(\"DEPRECATION\") view.announceForAccessibility(spoken) } } }"))
        #expect(android.contains("private class ConclaveCounterBandMemory(var band: ConclaveCounterBand)"))
        #expect(android.contains("ConclaveCounterBand.over -> { val over = ConclaveComposerCounterPolicy.overflow(count = count, limit = limit) conclavePlural(\"ds_char_over_limit\", over, over) }"))
        #expect(android.contains("ConclaveCounterBand.near -> conclaveString(\"ds_char_count\", count, limit)"))
        // The only announcement in the file is this one, and the component stays inert (no LaunchedEffect, no timer).
        #expect(android.components(separatedBy: "announceForAccessibility(").count - 1 == 1)
        #expect(!android.contains("LaunchedEffect") && !android.contains("Timer"))
    }

    @Test func onlyTheComposerCountersOptIn() throws {
        // Chat (T3B-2) and the Q&A question (request T3B-1 R1) may pass true; the Lobby, Account, Settings, host Notice,
        // Q&A answer, webinar landing and dialog counters stay silent (R12).
        let allowed: Set<String> = [
            "Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift", "Sources/Conclave/Skip/ui/chat/ChatComposer.kt",
            "Sources/Conclave/Features/Meeting/Webinar/QaPanel+iOS.swift", "Sources/Conclave/Skip/ui/qa/QaPage.kt",
        ]
        let components: Set<String> = [Self.fieldsFile, Self.kotlinFile]
        var callers: [String] = []
        for file in try t3cFiles(under: "Sources/Conclave", extensions: ["swift", "kt"]) where !components.contains(file) {
            let text = t3cNormalized(try t3cSource(file))
            if text.contains("announcesBands: true") || text.contains("announcesBands = true") { callers.append(file) }
        }
        for file in callers { #expect(allowed.contains(file), "\(file) opts a counter into announcements") }
        for file in ["Sources/Conclave/Features/Lobby/LobbyView+iOS.swift", "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt",
                     "Sources/Conclave/Features/Account/AccountView+iOS.swift", "Sources/Conclave/Skip/ui/account/AccountScreen.kt",
                     "Sources/Conclave/Skip/ui/settings/SettingsRows.kt", "Sources/Conclave/Skip/ui/host/NoticeComposer.kt",
                     "Sources/Conclave/Features/Meeting/Webinar/QaAnswerPage+iOS.swift",
                     "Sources/Conclave/Features/Join/WebinarLandingView+iOS.swift", "Sources/Conclave/Skip/ui/join/WebinarLandingScreen.kt",
                     "Sources/Conclave/Skip/ui/components/ConclaveDialogs.kt"] {
            #expect(!(try t3cSource(file)).contains("announcesBands"), "\(file)")
        }
        // The chat composer uses the contract on both platforms (T3B-2).
        #expect(t3cNormalized(try t3cSource("Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift")).contains("announcesBands: true"), "T3B-2 opts the chat counter in")
        #expect(t3cNormalized(try t3cSource("Sources/Conclave/Skip/ui/chat/ChatComposer.kt")).contains("announcesBands = true"), "T3B-2 opts the chat counter in")
    }

    @Test func overLimitPluralIsAnAndroidResource() throws {
        // HD/strings/T3B-1.json: ds_char_over_limit (S40 6 g names it chat_over_limit; the counter is an F00 component).
        let xml = try t3cSource("Android/app/src/main/res/values/strings.xml")
        let block = try #require(t3cMatches(#"<plurals name="ds_char_over_limit">([\s\S]*?)</plurals>"#, in: xml).first, "T3B-1 strings merged")
        #expect(block[0].contains("<item quantity=\"one\">%1$d character over the limit</item>"))
        #expect(block[0].contains("<item quantity=\"other\">%1$d characters over the limit</item>"))
    }

    // MARK: Hygiene

    @Test func componentSourcesStayFlatQuietAndDashFree() throws {
        for file in [Self.glassFile, Self.fieldsFile, Self.modelsFile, Self.kotlinFile] {
            let text = try t3cSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) contains an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
        }
        // No haptics on any composer path (OD Q11, S40 6 h): the glass file, the iOS composer parts and the Kotlin composer.
        let glass = t3cWithoutAnyComments(try t3cSource(Self.glassFile))
        let fields = try t3cSource(Self.fieldsFile)
        let iosParts = t3cWithoutAnyComments(try t3cSection(fields, from: "struct ConclaveCharacterCounter: View {", to: "// MARK: Search (F00 C20)"))
        let kotlin = try t3cSource(Self.kotlinFile)
        let kotlinParts = t3cWithoutAnyComments(try t3cSection(kotlin, from: "internal fun ConclaveCharacterCounter(", to: "// Search (F00 C20)"))
        for (name, part) in [("glass", glass), ("iOS parts", iosParts), ("Kotlin parts", kotlinParts)] {
            for token in ["sensoryFeedback", "Haptic", "haptic", "FeedbackKind", "conclaveGestureFeedback", "Vibrator"] {
                #expect(!part.contains(token), "\(name) uses \(token)")
            }
        }
        // FND-3 pins: no tint in the iOS fields file, one popup root in the Kotlin fields file, glass only in the two files.
        #expect(!fields.contains(".tint("))
        #expect(kotlin.components(separatedBy: "NativeSemanticsPopupRoot(").count - 1 == 1)
        for pattern in ["glassEffect", "GlassEffectContainer", "glassProminent"] { #expect(!fields.contains(pattern)) }
        // The highlight of P1 is never coral and the components add no new coral use: one coralText Send glyph and the
        // reply rule on iOS, primary on Android.
        #expect(fields.components(separatedBy: "HostingTheme.coralText").count - 1 == 2)
        #expect(!kotlin.contains("primaryContainer"))
        // iOS 17 floor: nothing newer than iOS 17 outside the existing iOS 26 and 27 material gates.
        #expect(!fields.contains("@available(iOS 18") && !fields.contains("#available(iOS 18"))
        // The shared models stay Skip Lite.
        let models = try t3cSource(Self.modelsFile)
        #expect(!models.contains("#if") && t3cMatches(#"case [a-z][A-Za-z]*\("#, in: models).isEmpty && t3cMatches(#"-> \("#, in: models).isEmpty)
    }
}

// MARK: Helpers (private to this file)

private func t3cPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func t3cSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: t3cPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func t3cFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = t3cPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func t3cNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func t3cWithoutComments(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

/// Code only: line comments and block comments (KDoc included) removed.
private func t3cWithoutAnyComments(_ text: String) -> String {
    let blockless = text.replacingOccurrences(of: #"/\*[\s\S]*?\*/"#, with: "", options: .regularExpression)
    return t3cWithoutComments(blockless)
}

private func t3cSection(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func t3cMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (1..<max(match.numberOfRanges, 2)).map { index in
            guard index < match.numberOfRanges else { return "" }
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}

/// The ranges of every block that opens with `marker` (which ends in "{"), through its matching closing brace.
private func t3cBracedBlocks(after marker: String, in text: String) -> [Range<String.Index>] {
    var result: [Range<String.Index>] = []
    var start = text.startIndex
    while let found = text.range(of: marker, range: start..<text.endIndex) {
        var depth = 1
        var index = found.upperBound
        while index < text.endIndex && depth > 0 {
            if text[index] == "{" { depth += 1 } else if text[index] == "}" { depth -= 1 }
            index = text.index(after: index)
        }
        result.append(found.lowerBound..<index)
        start = index
    }
    return result
}
#endif
