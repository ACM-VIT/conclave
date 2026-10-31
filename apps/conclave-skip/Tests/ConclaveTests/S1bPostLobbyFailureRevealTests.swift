#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1bPostLobbyFailureRevealTests {
    static let lobbyFile = "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift"
    static let entryFile = "Sources/Conclave/Features/Lobby/EntryStatusBlock+iOS.swift"
    static let rowsFile = "Sources/Conclave/Features/Lobby/LobbyStatusRow+iOS.swift"

    static let reveal = ".onChange(of: revealsStatusReason) { _, reveals in "
        + "guard reveals, dynamicTypeSize.isAccessibilitySize else { return } "
        + "withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) { "
        + "proxy.scrollTo(LobbyScrollAnchor.status, anchor: .top) } }"

    static let predicate = "private var revealsStatusReason: Bool { "
        + "guard let status = premeeting.lobbyStatus, status.routeId == route.id else { return false } "
        + "let reasonRows = LobbyStatusPolicy.rows(status: status, media: nil, supportsRationale: false, offersAppInfo: false) "
        + "if reasonRows.contains(where: { $0.kind == .issue }) { return true } "
        + "let refused = status.mode == .editing && [LobbyIssue.roomNotFound, .signInRequired, .failedServerText].contains(status.issue) "
        + "guard status.mode == .failed || refused else { return false } "
        + "let isSignedIn = premeeting.lobbyIdentity?.routeId == route.id && premeeting.lobbyIdentity?.isSignedIn == true "
        + "return LobbyStatusCopy.line(status: status, isSignedIn: isSignedIn) != nil }"

    static let link = "https://conclave.acmvit.in/rose-sora-luffy"

    @Test func theDeviceCellFixtureFailsAfterTwoSecondsWithTheSlotIdentifier() {
        let steps = PremeetingFixtureScript.steps(for: .failedServerBusy)
        #expect(steps.map { $0.delayMillis } == [0, 2000], "connecting first, the failure two seconds later")
        #expect(LobbyStatusPolicy.lineIdentifier(.failedServerBusy) == "lobby.status")
    }

    @Test func aRefusedJoinFlipsTheRevealOnEveryAttemptAndAStaleErrorNever() {
        let premeeting = presenter(isSignedIn: false, accountName: "Avery", accountSeed: "")
        premeeting.apply(PremeetingInputs.make(callSession: 1, notice: .formError, noticeText: "No room found.", accountName: "Avery"))
        premeeting.handleIncomingURL(Self.link)
        let routeId = premeeting.path.last?.id ?? -1
        #expect(premeeting.lobbyStatus?.routeId == routeId && premeeting.lobbyStatus?.mode == .editing)
        var trail = [reveals(premeeting, routeId: routeId)]
        var issues: [LobbyIssue] = []
        let refusals = ["No room found for this code.", "Guests are not allowed in this meeting.", "You are not allowed to join this meeting."]
        for (index, sentence) in refusals.enumerated() {
            let session = index + 2
            premeeting.apply(PremeetingInputs.make(callSession: session, phase: .entering, roomLabel: "rose-sora-luffy",
                                                   currentRoomId: "rose-sora-luffy", accountName: "Avery"))
            trail.append(reveals(premeeting, routeId: routeId))
            premeeting.apply(PremeetingInputs.make(callSession: session, notice: .formError, noticeText: sentence, accountName: "Avery"))
            trail.append(reveals(premeeting, routeId: routeId))
            issues.append(premeeting.lobbyStatus?.issue ?? LobbyIssue.none)
            #expect(premeeting.lobbyStatus?.mode == .editing, "\(sentence)")
        }
        #expect(issues == [.roomNotFound, .signInRequired, .failedServerText])
        #expect(trail == [false, false, true, false, true, false, true],
                "a stale error at open never reveals, and every refusal flips the observed value from false to true")
        #expect(!reveals(premeeting, routeId: routeId + 1), "a status for another route never reveals")
    }

    @Test func aRefusalWithNoSlotLineNeverReveals() {
        let premeeting = presenter(isSignedIn: true, accountName: "Avery Lee", accountSeed: "u1")
        premeeting.handleIncomingURL(Self.link)
        let routeId = premeeting.path.last?.id ?? -1
        premeeting.apply(PremeetingInputs.make(callSession: 2, phase: .entering, roomLabel: "rose-sora-luffy", currentRoomId: "rose-sora-luffy",
                                               isSignedIn: true, accountName: "Avery Lee", accountSeed: "u1"))
        premeeting.apply(PremeetingInputs.make(callSession: 2, notice: .formError, noticeText: "Guests are not allowed in this meeting.",
                                               isSignedIn: true, accountName: "Avery Lee", accountSeed: "u1"))
        #expect(premeeting.lobbyStatus?.mode == .editing && premeeting.lobbyStatus?.issue == .signInRequired)
        #expect(!reveals(premeeting, routeId: routeId), "signed in, the sign-in refusal has no line, so nothing scrolls to an empty slot")

        premeeting.apply(PremeetingInputs.make(callSession: 3, phase: .entering, roomLabel: "rose-sora-luffy", currentRoomId: "rose-sora-luffy",
                                               isSignedIn: true, accountName: "Avery Lee", accountSeed: "u1"))
        premeeting.apply(PremeetingInputs.make(callSession: 3, notice: .formError, noticeText: "Meeting invite code required",
                                               isSignedIn: true, accountName: "Avery Lee", accountSeed: "u1"))
        #expect(premeeting.lobbyIdentity?.needsInviteCode == true)
        #expect(!reveals(premeeting, routeId: routeId), "the invite field and its announcement carry the invite refusal")
    }

    @Test func theRefusalDeviceCellFixturesRefuseHalfASecondAfterTheLobbyOpens() {
        for state in [PremeetingFixtureState.lobbyRoomNotFound, .lobbyServerText] {
            let steps = PremeetingFixtureScript.steps(for: state)
            #expect(steps.map { $0.delayMillis } == [0, 500], "\(state): the lobby first, the form error 500 ms later")
        }
        #expect(PremeetingFixtureScript.delayedStepMillis == 500)
        #expect(LobbyStatusPolicy.lineIdentifier(.roomNotFound) == "lobby.primary.reason")
    }

    @Test func aPausedRefusalRevealsItsStatusRowOnEveryAttemptAndAStaleOneNever() {
        let sentence = PremeetingFixtureScript.formError(for: .lobbyAppSuspended)
        let premeeting = presenter(isSignedIn: false, accountName: "Avery", accountSeed: "")
        premeeting.apply(PremeetingInputs.make(callSession: 1, notice: .formError, noticeText: sentence, accountName: "Avery"))
        premeeting.handleIncomingURL(Self.link)
        let routeId = premeeting.path.last?.id ?? -1
        #expect(premeeting.lobbyStatus?.routeId == routeId && premeeting.lobbyStatus?.issue == LobbyIssue.none)
        var trail = [reveals(premeeting, routeId: routeId)]
        for session in [2, 3] {
            premeeting.apply(PremeetingInputs.make(callSession: session, phase: .entering, roomLabel: "rose-sora-luffy",
                                                   currentRoomId: "rose-sora-luffy", accountName: "Avery"))
            trail.append(reveals(premeeting, routeId: routeId))
            premeeting.apply(PremeetingInputs.make(callSession: session, notice: .formError, noticeText: sentence, accountName: "Avery"))
            trail.append(reveals(premeeting, routeId: routeId))
            let status = premeeting.lobbyStatus
            #expect(status?.mode == .editing && status?.issue == .appSuspended, "attempt \(session)")
            if let status {
                #expect(LobbyStatusPolicy.line(status: status, isSignedIn: false) == LobbyStatusLineKind.none,
                        "the paused reason has no slot line, which is why the line rule alone missed it")
                let rows = LobbyStatusPolicy.rows(status: status, media: nil, supportsRationale: false, offersAppInfo: false)
                #expect(rows.map { $0.kind } == [LobbyStatusRowKind.issue] && rows.map { $0.issue } == [LobbyIssue.appSuspended],
                        "the reason is the status row")
            }
        }
        #expect(trail == [false, false, true, false, true],
                "a stale pause at open never reveals, and every paused refusal flips the observed value from false to true")
        #expect(!reveals(premeeting, routeId: routeId + 1), "a status for another route never reveals")
    }

    @Test func thePausedRowIsTheReasonOnlyWhileTheLobbyIsEditing() {
        for mode in [LobbyMode.connecting, .waiting, .failed] {
            let status = LobbyStatusSnapshot(routeId: 1, intent: .join, mode: mode, issue: .appSuspended, issueServerText: "",
                                             isPrimaryEnabled: false, primaryReason: "", showsSlowNotice: false,
                                             waitingKind: .standard, isPrimaryPending: false, waitingText: "")
            #expect(LobbyStatusPolicy.rows(status: status, media: nil, supportsRationale: true, offersAppInfo: true).isEmpty, "\(mode)")
        }
        let editing = LobbyStatusSnapshot(routeId: 1, intent: .join, mode: .editing, issue: .appSuspended, issueServerText: "",
                                          isPrimaryEnabled: true, primaryReason: "", showsSlowNotice: false,
                                          waitingKind: .standard, isPrimaryPending: false, waitingText: "")
        for flag in [false, true] {
            #expect(LobbyStatusPolicy.rows(status: editing, media: nil, supportsRationale: flag, offersAppInfo: flag).map { $0.kind }
                    == [LobbyStatusRowKind.issue], "the platform flags change the action, never whether the row shows")
        }
    }

    @Test func thePausedRowSitsInsideTheStatusAnchorAndTheFixtureRefusesAfterHalfASecond() throws {
        let steps = PremeetingFixtureScript.steps(for: .lobbyAppSuspended)
        #expect(steps.map { $0.delayMillis } == [0, 500], "the lobby first, the pause 500 ms later")
        #expect(PremeetingFixtureScript.isLobbyFixture(.lobbyAppSuspended))
        let classified = LobbyIssuePolicy.classify(formError: PremeetingFixtureScript.formError(for: .lobbyAppSuspended), enteredInviteCode: "")
        #expect(classified.issue == .appSuspended && !classified.needsInviteCode)
    }

    private func presenter(isSignedIn: Bool, accountName: String, accountSeed: String) -> PremeetingPresenter {
        let premeeting = PremeetingPresenter()
        premeeting.nowMillis = { 1793102400000.0 }
        premeeting.presenceIntervalMillis = 5
        premeeting.apply(PremeetingInputs.make(isSignedIn: isSignedIn, accountName: accountName, accountSeed: accountSeed))
        return premeeting
    }

    private func reveals(_ premeeting: PremeetingPresenter, routeId: Int) -> Bool {
        guard let status = premeeting.lobbyStatus, status.routeId == routeId else { return false }
        let reasonRows = LobbyStatusPolicy.rows(status: status, media: nil, supportsRationale: false, offersAppInfo: false)
        if reasonRows.contains(where: { $0.kind == .issue }) { return true }
        let refused = status.mode == .editing && [LobbyIssue.roomNotFound, .signInRequired, .failedServerText].contains(status.issue)
        guard status.mode == .failed || refused else { return false }
        let isSignedIn = premeeting.lobbyIdentity?.routeId == routeId && premeeting.lobbyIdentity?.isSignedIn == true
        return LobbyStatusPolicy.line(status: status, isSignedIn: isSignedIn) != LobbyStatusLineKind.none
    }
}

private func s1bpfrSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bpfrFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private struct S1bPostLobbyFailureRevealBlockMissing: Error {}

private func s1bpfrBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw S1bPostLobbyFailureRevealBlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
