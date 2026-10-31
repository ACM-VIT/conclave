#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct EntryFirstScreenTests {

    @Test func aBootstrappedPresenterStartsAtHome() {
        let guest = PremeetingPresenter()
        guest.nowMillis = { 1793102400000.0 }
        guest.bootstrap(user: nil, recents: [])
        #expect(guest.path.isEmpty)
        #expect(guest.root == PremeetingRootDecision.home)
        #expect(guest.outcome == nil)
        #expect(!guest.isJoinSheetPresented && !guest.isAccountSheetPresented)
        #expect(!guest.home.isSignedIn)

        let signedIn = PremeetingPresenter()
        signedIn.nowMillis = { 1793102400000.0 }
        let record = RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: "lily-zoro-iris", joinMode: .meeting),
                                         roomId: "lily-zoro-iris", title: "Standup", joinMode: JoinMode.meeting.rawValue,
                                         role: RecentRole.host.rawValue, lastJoinedAtMillis: 1792839600000.0,
                                         endedAtMillis: 1792843200000.0, end: RecentEnd.left.rawValue)
        signedIn.bootstrap(user: AppState.User(id: "u1", name: "Avery Lee", email: "avery@example.com", provider: .google),
                           recents: [record])
        #expect(signedIn.path.isEmpty, "recents and a signed-in account never push a route at launch")
        #expect(signedIn.root == PremeetingRootDecision.home)
        #expect(signedIn.outcome == nil)
        #expect(signedIn.home.isSignedIn)
        #expect(signedIn.recentRecords.count == 1)
    }

    @Test func theMobileDefaultGetterYieldsBothNativeRoots() throws {
        let mobile = NativeRouteFlags(nativeUIAvailable: true)
        #expect(mobile.enabledKeys == [.premeeting, .call])
        #expect(mobile.isEnabled(.premeeting) && mobile.isEnabled(.call))
        #expect(mobile.routesPremeetingNatively)
        #expect(mobile.premeetingFixture.isEmpty)
        mobile.configure(routes: "none", premeetingFixture: "inCall", debugEligible: false)
        #expect(mobile.enabledKeys == [.premeeting, .call])
        #expect(mobile.premeetingFixture.isEmpty)
    }

    @Test func theDefaultGetterMatchesTheHostPlatform() {
        let flags = NativeRouteFlags()
        #if os(iOS)
        #expect(NativeRouteFlags.nativeUIAvailable)
        #expect(flags.enabledKeys == [.premeeting, .call])
        #else
        #expect(!NativeRouteFlags.nativeUIAvailable, "the macOS host keeps the legacy default")
        #expect(flags.enabledKeys.isEmpty)
        #expect(!flags.isEnabled(.premeeting) && !flags.isEnabled(.call))
        #expect(!flags.routesPremeetingNatively)
        flags.configure(routes: "premeeting,call", premeetingFixture: nil, debugEligible: false)
        #expect(flags.enabledKeys.isEmpty)
        #endif
    }
}

private func entryFirstScreenSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private struct EntryFirstScreenRangeMissing: Error {
    let marker: String
}

private func entryFirstScreenBody(_ source: String, from start: String, to end: String) throws -> String {
    guard let startRange = source.range(of: start) else { throw EntryFirstScreenRangeMissing(marker: start) }
    guard let endRange = source.range(of: end, range: startRange.upperBound..<source.endIndex) else {
        throw EntryFirstScreenRangeMissing(marker: end)
    }
    return String(source[startRange.upperBound..<endRange.lowerBound])
}
#endif
