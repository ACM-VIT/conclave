#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct CTL6ReactionsHandTests {
    static let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "ctl6-tests")

    static func joined(isHandRaised: Bool = false, isReactionsDisabled: Bool = false, isAdmin: Bool = false) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .joined, roomId: "abc-defg-hij", displayName: "You", isAdmin: isAdmin,
                                isMuted: false, isCameraOff: false, isHandRaised: isHandRaised, isReactionsDisabled: isReactionsDisabled)
    }

    @Test func paletteIsTheSixEmojiWithWordLabelsAndNoArtYet() {
        let emoji = ReactionPalettePolicy.emojiOptions()
        #expect(emoji.map { $0.id } == MeetingReactionConstants.emojiOptions)
        #expect(emoji.map { $0.nameKey } == ["thumbsUp", "clap", "laugh", "heart", "party", "wow"])
        #expect(emoji.allSatisfy { $0.kind == ReactionKind.emoji.rawValue })

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

        #expect(session.counters.reaction == 3 && session.controls.reactionCount == 3)
        #expect(session.controls.bar.revision == bar && session.controls.more.revision == more)

        #expect(session.controls.sendReaction(id: "🤔") == .ignored)
        #expect(session.controls.sendReaction(id: "/reactions/aura.gif") == .ignored)
        #expect(session.counters.reaction == 3)
        #expect(ControlsFixtureSession(state: .reactionsOff).controls.sendReaction(id: "👍") == .ignored)
        #expect(ControlsFixtureSession(state: .recovering).controls.sendReaction(id: "👍") == .ignored)

        let hostOff = ControlsFixtureSession(state: .hostReactionsOff)
        #expect(hostOff.controls.sendReaction(id: "🎉") == .dispatched)
        #expect(hostOff.counters.reaction == 1)
        #expect(session.countersReadout().contains("reaction=3"))
    }

    @Test func aRaiseShowsRaisingInTheTapsFrameAndTheStageFollowsUntilTheAck() async {
        let session = ControlsFixtureSession(state: .slowAck)
        session.sleep = { _ in }
        #expect(session.controls.handState == .lowered && session.stage.localHand == .lowered)
        #expect(session.controls.select(.hand) == .dispatched)

        let row = session.controls.more.item(.hand)
        #expect(row?.isPending == true && row?.isEnabled == false && row?.status == .pending)
        #expect(session.controls.handState == .raising && session.stage.localHand == .raising)
        #expect(session.handReadout().hasPrefix("more=raising stage=raising"))

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

        #expect(h.controls.handState == .raised && h.controls.more.item(.hand)?.isPending == false)
        let s1 = h.shell.controls.rows.first { $0.id == MeetingControlID.hand.rawValue }
        #expect(s1?.failure == .ackTimedOut && s1?.failureDirection == .lower)

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

    @Test func noReactionArtShipsYet() throws {

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
}

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
