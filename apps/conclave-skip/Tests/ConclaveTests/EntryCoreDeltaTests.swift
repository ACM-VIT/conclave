#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct EntryCoreDeltaTests {

    @Test func nativeIntakeSendsConclaveLinksToTheRegisteredPresenter() {
        let delegate = ConclaveAppDelegate.shared
        let presenter = PremeetingPresenter()
        delegate.registerPremeeting(presenter)
        defer { delegate.registerPremeeting(nil) }

        #expect(delegate.routeNatively("conclave://"))
        #expect(presenter.home.noticeKind == .invalidLink)

        #expect(!delegate.routeNatively("https://example.com/x"))

        #expect(delegate.routeNatively("conclave://rose-sora-luffy"))
        #expect(presenter.path.last?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.mode == .editing)
    }

    @Test func aLinkBeforeTheRootRegistersWaitsForIt() {
        let delegate = ConclaveAppDelegate.shared
        delegate.registerPremeeting(nil)
        #expect(delegate.routeNatively("https://conclave.acmvit.in/lily-zoro-iris"))
        let presenter = PremeetingPresenter()
        delegate.registerPremeeting(presenter)
        defer { delegate.registerPremeeting(nil) }

        #expect(presenter.path.map { $0.roomId } == ["lily-zoro-iris"])
    }

    static let sharedSwiftFiles = [
        "Sources/Conclave/App/NativeRouteFlags.swift",
        "Sources/Conclave/Features/Home/PremeetingContracts.swift",
        "Sources/Conclave/Features/Home/PremeetingPresenter.swift",
        "Sources/Conclave/Features/Home/PremeetingFixtures.swift",
        "Sources/Conclave/Features/Home/PremeetingAppWiring.swift",
        "Sources/Conclave/Features/Home/RecentMeetingsStore.swift",
        "Sources/Conclave/Features/Join/EntryPolicies.swift"
    ]
    static let newSwiftFiles = sharedSwiftFiles + [
        "Sources/Conclave/Features/Home/HomeView+iOS.swift",
        "Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift",
        "Sources/Conclave/Features/Join/JoinCodeSheet+iOS.swift"
    ]
    static let newKotlinFiles = [
        "Sources/Conclave/Skip/ui/home/HomeScreen.kt",
        "Sources/Conclave/Skip/ui/home/HomeRowsCache.kt",
        "Sources/Conclave/Skip/ui/home/PremeetingBackStack.kt",
        "Sources/Conclave/Skip/ui/home/PremeetingHost.kt",
        "Sources/Conclave/Skip/ui/join/JoinCodeSheet.kt"
    ]
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct EntryCoreDeltaViewModelTests {
    @Test func theShellRefreshAlsoFeedsThePremeetingPresenter() {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "lily-zoro-iris"
        viewModel.state.connectionState = ConnectionState.connecting
        #expect(viewModel.premeeting.currentInputs.phase == .entering)
        #expect(viewModel.premeeting.currentInputs.currentRoomId == "lily-zoro-iris")
        #expect(viewModel.premeeting.path.last?.kind == .lobby)
        #expect(viewModel.premeeting.lobbyStatus?.mode == .connecting)
        viewModel.state.connectionState = ConnectionState.joined
        #expect(viewModel.premeeting.root.root == .call)
        #expect(viewModel.makePremeetingInputs() == viewModel.premeeting.currentInputs)
    }

    @Test func identityAndAppActivityArePushedOnceEach() {
        let viewModel = MeetingViewModel()
        viewModel.setPremeetingIdentity(isSignedIn: true, accountName: "Avery", accountSeed: "u1")
        #expect(viewModel.premeeting.home.isSignedIn)
        #expect(viewModel.premeeting.home.accountName == "Avery")
        let count = viewModel.premeeting.snapshotPublishCount
        viewModel.setPremeetingIdentity(isSignedIn: true, accountName: "Avery", accountSeed: "u1")
        #expect(viewModel.premeeting.snapshotPublishCount == count)
        viewModel.setPremeetingAppActive(false)
        #expect(!viewModel.premeeting.currentInputs.isAppActive)
        viewModel.setPremeetingAppActive(true)
        #expect(viewModel.premeeting.currentInputs.isAppActive)
        #expect(viewModel.premeeting.onCommand != nil)
    }
}
#endif

private func entrySource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func entryFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func entryMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
