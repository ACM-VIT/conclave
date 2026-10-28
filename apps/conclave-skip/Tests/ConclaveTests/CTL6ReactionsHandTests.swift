#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CTL-6 (OUT/PLAN-screens.md section 5): the reactions palette and tray, and Raise Hand with honest acknowledgment. The
/// shared `ReactionPalettePolicy`, the presenter's `sendReaction(id:)` and `handState`, the S20 SC12 hand ticket on the
/// stage (the fixture mirror of HD/requests/B6-T3.md R1.d) and the More hand row run here against the real S1 shell and
/// stage; the iOS tray and the Kotlin palette and hand tile are read. The Kotlin half is T/Skip/CTL5CTL6BridgeTests.kt.
/// Covers S30 6 l (unit halves of l1, l3 to l6), 6 f (states), 6 j (ids are the wire values), CC3 (a failed lower keeps
/// the server state and its direction), CC14 and Q10 (no art row until flat art ships), SC12 (raising within the tap's
/// frame), R12 (no reaction art bundled). Not run in the heads-down push.
@MainActor
struct CTL6ReactionsHandTests {
    static let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "ctl6-tests")

    static func joined(isHandRaised: Bool = false, isReactionsDisabled: Bool = false, isAdmin: Bool = false) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .joined, roomId: "abc-defg-hij", displayName: "You", isAdmin: isAdmin,
                                isMuted: false, isCameraOff: false, isHandRaised: isHandRaised, isReactionsDisabled: isReactionsDisabled)
    }

    // MARK: Palette (S30 6 c, d, g, j; F00 C22)

    @Test func paletteIsTheSixEmojiWithWordLabelsAndNoArtYet() {
        let emoji = ReactionPalettePolicy.emojiOptions()
        #expect(emoji.map { $0.id } == MeetingReactionConstants.emojiOptions)
        #expect(emoji.map { $0.nameKey } == ["thumbsUp", "clap", "laugh", "heart", "party", "wow"])
        #expect(emoji.allSatisfy { $0.kind == ReactionKind.emoji.rawValue })
        // CC14, Q10: the art row waits for flat assets; the wire ids and names are ready for them.
        #expect(!ReactionPalettePolicy.artShipped && ReactionPalettePolicy.artOptions(artShipped: false).isEmpty)
        let art = ReactionPalettePolicy.artOptions(artShipped: true)
        #expect(art.map { $0.id } == ["/reactions/aura.gif", "/reactions/crycry.gif", "/reactions/goblin.gif", "/reactions/phone.gif",
                                      "/reactions/sixseven.gif", "/reactions/yawn.gif"])
        #expect(art.map { $0.nameKey } == ["aura", "crying", "goblin", "phone", "sixSeven", "yawn"])
        #expect(art.allSatisfy { $0.kind == ReactionKind.asset.rawValue })
        #expect(ReactionPalettePolicy.option(id: "👍")?.kind == .emoji && ReactionPalettePolicy.option(id: "/reactions/aura.gif")?.kind == .asset)
        #expect(ReactionPalettePolicy.option(id: "🤔") == nil && ReactionPalettePolicy.nameKey("🤔").isEmpty)
        let session = ControlsFixtureSession(state: .guest)
        #expect(session.controls.reactions.emoji.count == 6 && session.controls.reactions.art.isEmpty)
        #expect(session.controls.more.item(.moreReactions) == nil)
    }

    @Test func availabilityFollowsTheS1ReactionsRow() {
        #expect(ControlsFixtureSession(state: .guest).controls.reactions.availability == .available)
        // A guest sees the reason; a host keeps the palette when reactions are off (web parity, 6 f).
        #expect(ControlsFixtureSession(state: .reactionsOff).controls.reactions.availability == .disabledByHost)
        #expect(ControlsFixtureSession(state: .hostReactionsOff).controls.reactions.availability == .available)
        #expect(ControlsFixtureSession(state: .recovering).controls.reactions.availability == .reconnecting)
        #expect(ControlsFixtureSession(state: .offline).controls.reactions.availability == .offline)
        #expect(ControlsFixtureSession(state: .attendee).controls.reactions.availability == .attendee)
        let off = ControlsFixtureSession(state: .reactionsOff).controls.more.item(.reactions)
        #expect(off?.isEnabled == false && off?.reason == .disabledByHost)
        #expect(ReactionPalettePolicy.reason(.reconnecting) == .reconnecting && ReactionPalettePolicy.reason(.available) == .none)
    }

    @Test func sendsResolveTheWireIdAndNeverTouchTheBarOrMore() {
        let session = ControlsFixtureSession(state: .guest)
        let bar = session.controls.bar.revision
        let more = session.controls.more.revision
        for _ in 0..<3 {
            #expect(session.controls.sendReaction(id: "👍") == .dispatched)
        }
        // S30 6 l3: three sends, three counts; the sheet (and the tray) stay open because nothing else changes (6 k).
        #expect(session.counters.reaction == 3 && session.controls.reactionCount == 3)
        #expect(session.controls.bar.revision == bar && session.controls.more.revision == more)
        // An id outside the palette, or art before it ships, is ignored instead of being dropped silently by the core.
        #expect(session.controls.sendReaction(id: "🤔") == .ignored)
        #expect(session.controls.sendReaction(id: "/reactions/aura.gif") == .ignored)
        #expect(session.counters.reaction == 3)
        #expect(ControlsFixtureSession(state: .reactionsOff).controls.sendReaction(id: "👍") == .ignored)
        #expect(ControlsFixtureSession(state: .recovering).controls.sendReaction(id: "👍") == .ignored)
        // A host keeps the palette when reactions are off (6 f). The session stays in a local: the scripted core holds
        // it weakly, so a temporary session can be released before its request handler runs.
        let hostOff = ControlsFixtureSession(state: .hostReactionsOff)
        #expect(hostOff.controls.sendReaction(id: "🎉") == .dispatched)
        #expect(hostOff.counters.reaction == 1)
        #expect(session.countersReadout().contains("reaction=3"))
    }

    // MARK: Raise hand (S30 6 f, SC12, CC3)

    @Test func aRaiseShowsRaisingInTheTapsFrameAndTheStageFollowsUntilTheAck() async {
        let session = ControlsFixtureSession(state: .slowAck)
        session.sleep = { _ in }
        #expect(session.controls.handState == .lowered && session.stage.localHand == .lowered)
        #expect(session.controls.select(.hand) == .dispatched)
        // SC12: raising on the More row and on the S20 chip in the same call that dispatched the ticket.
        let row = session.controls.more.item(.hand)
        #expect(row?.isPending == true && row?.isEnabled == false && row?.status == .pending)
        #expect(session.controls.handState == .raising && session.stage.localHand == .raising)
        #expect(session.handReadout().hasPrefix("more=raising stage=raising"))
        // Pending taps are ignored (the row is disabled; S1 DUP).
        #expect(session.controls.select(.hand) == .ignored && session.counters.toggleHand == 1)
        var turns = 0
        while session.controls.handState != .raised && turns < 50 {
            await Task.yield()
            turns += 1
        }
        #expect(session.controls.handState == .raised && session.stage.localHand == .raised)
        #expect(session.controls.more.item(.hand)?.isOn == true && session.controls.more.item(.hand)?.isEnabled == true)
    }

    @Test func theMoreHandRaisingFixtureStartsPending() {
        let session = ControlsFixtureSession(state: .moreHandRaising)
        #expect(session.controls.bar.composition == .compact)
        #expect(session.controls.more.item(.hand)?.isPending == true)
        #expect(session.handReadout() == "more=raising stage=raising reactions=available")
    }

    @Test func aFailedLowerKeepsTheServerStateAndItsDirection() {
        let h = HandHarness(Self.joined(isHandRaised: true))
        #expect(h.controls.handState == .raised)
        #expect(h.controls.select(.hand) == .dispatched)
        #expect(h.controls.handState == .lowering && h.controls.more.item(.hand)?.isPending == true)
        #expect(h.tickets.count == 1)
        if let ticket = h.tickets.last {
            _ = h.shell.finish(ticket, MeetingActionResult.failed(.ackTimedOut, direction: .lower))
        }
        h.refresh()
        // CC3: the row returns to the server state (still raised) and carries the lower direction for its toast.
        #expect(h.controls.handState == .raised && h.controls.more.item(.hand)?.isPending == false)
        let s1 = h.shell.controls.rows.first { $0.id == MeetingControlID.hand.rawValue }
        #expect(s1?.failure == .ackTimedOut && s1?.failureDirection == .lower)
        // A recovery mid-raise interrupts the ticket quietly (S1C 3.3 ACK): no failure, the server state stays.
        let raising = HandHarness(Self.joined())
        _ = raising.controls.select(.hand)
        if let ticket = raising.tickets.last {
            _ = raising.shell.finish(ticket, MeetingActionResult.interrupted)
        }
        raising.refresh()
        #expect(raising.controls.handState == .lowered)
        #expect(raising.shell.controls.rows.first { $0.id == MeetingControlID.hand.rawValue }?.failure == MeetingActionFailure.none)
    }

    @Test func anEchoBeforeTheAcknowledgmentKeepsRaising() {
        // INM B5: the handRaised echo can land before the ack; the row keeps the direction the controls dispatched.
        let h = HandHarness(Self.joined())
        #expect(h.controls.select(.hand) == .dispatched && h.controls.handIntent == .raise)
        h.shell.apply(Self.joined(isHandRaised: true))
        h.refresh()
        #expect(h.controls.more.item(.hand)?.isPending == true && h.controls.more.item(.hand)?.isOn == true)
        #expect(h.controls.handState == .raising && MoreMenuPolicy.handState(h.controls.more.item(.hand)) == .raising)
        if let ticket = h.tickets.last {
            _ = h.shell.finish(ticket, MeetingActionResult.completed)
        }
        h.refresh()
        #expect(h.controls.handState == .raised && h.controls.handIntent == .none)
        // Without a known intent the server state decides (a pending row that is up is lowering).
        #expect(MoreMenuPolicy.handState(isOn: true, isPending: true, intent: "") == .lowering)
        #expect(MoreMenuPolicy.handState(isOn: true, isPending: true, intent: "raise") == .raising)
    }

    @Test func theHandRowIsOmittedOnTheWideBarAndAbsentForAttendees() {
        let wide = ControlsFixtureSession(state: .wide)
        #expect(wide.controls.more.item(.hand) == nil && wide.controls.bar.control(.hand) != nil)
        let attendee = ControlsFixtureSession(state: .attendee)
        #expect(attendee.controls.more.sections.isEmpty && attendee.controls.more.itemIds.isEmpty)
        #expect(MoreMenuPolicy.handState(nil) == .lowered)
    }

    // MARK: Source scans and assets

    @Test func iosTrayStaysOpenAcrossSendsAndNeverDoublesInVideo() throws {
        let tray = ctl6Normalized(try ctl6Source("Sources/Conclave/Features/Meeting/Controls/ReactionsTray+iOS.swift"))
        #expect(tray.hasPrefix("#if os(iOS) && !SKIP"))
        // CL7: a popover in regular width, a height-detent sheet with background interaction in compact width.
        #expect(tray.contains(".popover(isPresented: $isPresented, arrowEdge: .bottom)"))
        #expect(tray.contains(".presentationDetents([.height(trayHeight)])"))
        #expect(tray.contains(".presentationBackgroundInteraction(.enabled(upThrough: .height(trayHeight)))"))
        #expect(tray.contains("controls.stage.setTransientChrome(id: ChromeAutoHidePolicy.reactionsTray, open: open)"))
        #expect(tray.contains("if controls.sendReaction(id: id) == ControlTapResult.dispatched { sendCounter += 1 onSent() }"))
        #expect(tray.contains(".conclaveGestureFeedback(.reactionSent, trigger: sendCounter)"))
        #expect(tray.contains(".frame(minWidth: 44, minHeight: 44)") && tray.contains(".accessibilityLabel(MoreCopy.reactionLabel(option))"))
        // Q14: Conclave reactions never ask the system to render a gesture effect into the outgoing video.
        #expect(!tray.contains("performEffect(") && !tray.contains("glassEffect") && !tray.contains("sensoryFeedback("))
        let menu = ctl6Normalized(try ctl6Source("Sources/Conclave/Features/Meeting/Controls/MoreMenu+iOS.swift"))
        #expect(menu.contains(".reactionsTray(isPresented: $showsTray, controls: controls, onSent: { reactionCounter += 1 })"))
        #expect(menu.contains("ConclaveStrings.format(\"React with %@\", reactionName(option.nameKey))"))
        // The hand row's titles follow the SC12 state.
        for title in ["Raising Hand…", "Lowering Hand…", "Lower Hand", "Raise Hand"] {
            #expect(menu.contains("ConclaveStrings.text(\"" + title + "\")"), "\(title)")
        }
    }

    @Test func androidPaletteAndHandTilePlayOnlyWhenDispatched() throws {
        let component = ctl6Normalized(try ctl6Source("Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt"))
        let sheet = ctl6Normalized(try ctl6Source("Sources/Conclave/Skip/ui/call/controls/MoreSheet.kt"))
        #expect(component.contains("if (onReaction(option)) haptics.gesture(FeedbackKind.reactionSent)"))
        #expect(component.contains("if (onRaiseHand(raised)) haptics.gesture(kind)"))
        #expect(component.contains("CircularProgressIndicator(Modifier.size(20.dp), color = LocalContentColor.current, strokeWidth = 2.dp)"))
        // Font scale 2.0: targets grow and wrap in order (S30 6 d); the FND-2 pins hold.
        #expect(component.contains("FlowRow(modifier.fillMaxWidth().testTag(identifier), horizontalArrangement = Arrangement.SpaceEvenly)"))
        #expect(component.contains("Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)"))
        #expect(component.contains(".toggleable(value = raised, enabled = enabled, role = Role.Switch, onValueChange = onToggle)"))
        #expect(component.contains("haptics.gesture(FeedbackKind.reactionSent)") && component.contains("this.paneTitle = paneTitle"))
        #expect(sheet.contains("onReaction = { option -> controls.sendReaction(id = option.id) == ControlTapResult.dispatched },"))
        #expect(sheet.contains("onRaiseHand = { _ -> controls.select(MoreItemID.hand) == ControlTapResult.dispatched },"))
        #expect(sheet.contains("handPending = hand?.isPending ?: false,"))
        for name in ["ctl_raising_hand", "ctl_lowering_hand", "ctl_react_with", "ctl_reaction_thumbs_up", "ctl_reaction_wow"] {
            #expect(sheet.contains("\"" + name + "\""), "\(name)")
        }
        // No art row until flat art ships (CC14).
        #expect(!sheet.contains("painterResource"))
    }

    @Test func noReactionArtShipsYet() throws {
        // R12, R13 method precondition: nothing to scan until the flat assets land; the animated legacy GIFs never ship natively.
        let root = ctl6PackageRoot()
        var found: [String] = []
        for directory in ["Sources/Conclave/Resources", "Android/app/src/main/res", "Android/app/src/main/assets"] {
            let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
            while let url = enumerator?.nextObject() as? URL {
                let name = url.lastPathComponent.lowercased()
                if name.hasPrefix("reaction-") || name.hasSuffix(".gif") { found.append(name) }
            }
        }
        #expect(found.isEmpty, "reaction art: \(found)")
    }

    @Test func ctl6SourcesStayFlatAndDashFree() throws {
        for file in ["Sources/Conclave/Features/Meeting/Controls/ReactionPalettePolicy.swift",
                     "Sources/Conclave/Features/Meeting/Controls/ReactionsTray+iOS.swift",
                     "Tests/ConclaveTests/CTL6ReactionsHandTests.swift"] {
            let text = try ctl6Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file) mentions a forbidden fill")
        }
        let policy = try ctl6Source("Sources/Conclave/Features/Meeting/Controls/ReactionPalettePolicy.swift")
        #expect(!policy.contains("#if") && !policy.contains("protocol ") && policy.range(of: #"case\s+\w+\("#, options: .regularExpression) == nil)
    }
}

// MARK: Helpers (file-private, so no other suite collides)

/// The S1 shell, stage and controls with the publish hook mirrored, recording hand tickets so a test can finish them.
@MainActor
private final class HandHarness {
    let shell = MeetingShellPresenter()
    let stage: StagePresenter
    let controls: CallControlsPresenter
    var tickets: [MeetingActionTicket] = []

    init(_ inputs: MeetingShellInputs) {
        stage = StagePresenter(shell: shell)
        controls = CallControlsPresenter(shell: shell, stage: stage)
        shell.onCommand = { [weak self] _, ticket in
            if let ticket { self?.tickets.append(ticket) }
        }
        shell.onPublish = { [weak self] _, _, _ in self?.refresh() }
        shell.apply(inputs)
        refresh()
    }

    func refresh() {
        controls.apply(CallControlsInputs.fromShell(shell))
    }
}

private func ctl6PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func ctl6Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: ctl6PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func ctl6Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
