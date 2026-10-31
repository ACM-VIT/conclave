#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ENT2JoinCodeTests {
    @Test func submittingALinkPushesItsLobbyOnlyAfterTheSheetIsGoneWithTheInviteCode() throws {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        #expect(presenter.isJoinSheetPresented)
        presenter.submitJoinInput("https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc")
        #expect(!presenter.isJoinSheetPresented)
        #expect(presenter.path.isEmpty, "never pushed while the sheet is dismissing")
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.count == 1)
        let target = presenter.target(forRoute: try #require(presenter.path.first).id)
        #expect(target?.roomId == "rose-sora-luffy")
        #expect(target?.meetingInviteCode == "abc")
        #expect(target?.allowRoomCreation == true)
        #expect(target?.intent == .join)

        presenter.joinSheetDidDismiss()
        #expect(presenter.path.count == 1)
        #expect(presenter.feedbackState.token.kind == .none)
    }

    @Test func aTypedCodeAndAWebinarLinkOpenTheirPages() {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        presenter.submitJoinInput(EntryPolicies.sanitizeRoomInput("Rose Sora Luffy"))
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.map { $0.roomId } == ["rose-sora-luffy"])
        presenter.setPath([])
        presenter.openJoinSheet()
        presenter.submitJoinInput("https://conclave.acmvit.in/w/yuki-haz")
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.map { $0.kind } == [.webinarLanding])
    }

    @Test func aRejectedSubmitKeepsTheSheetAndPublishesValidationFailed() {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        presenter.submitJoinInput("https://example.com/rose")
        #expect(presenter.isJoinSheetPresented)
        #expect(presenter.feedbackState.token == FeedbackToken(sequence: 1, kind: .validationFailed))
        presenter.submitJoinInput("")
        #expect(presenter.feedbackState.token.sequence == 2)

        presenter.dismissJoinSheet()
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.isEmpty)
    }

    @Test func theRejoinSuggestionLeavesTheSheetBeforeOpeningTheLobby() {
        let presenter = PremeetingPresenter()
        let now: Double = 1793102400000.0
        presenter.nowMillis = { now }
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: now))
        presenter.openJoinSheet()
        presenter.rejoin()
        #expect(!presenter.isJoinSheetPresented)
        #expect(presenter.path.isEmpty)
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.intent == .rejoin)
    }

    @Test func entryStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent2Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in ["Meetings", "New Meeting", "Join", "Recent", "Join Meeting", "Meeting Code or Link", "Code or Link",
                    "This isn\u{2019}t a Conclave code or link.",
                    "Join Another Meeting?", "You\u{2019}re in %@. Leave it and join %@?", "Stay", "Leave and Join",
                    "This link can\u{2019}t be opened in Conclave.", "Update Conclave", "No Recent Meetings"] {
            let entry = strings[key] as? [String: Any]
            #expect(entry != nil, "missing \(key)")
            #expect(entry?["extractionState"] as? String == "manual", "\(key)")
        }
        let xml = try ent2Source("Android/app/src/main/res/values/strings.xml")
        for name in ["pm_app_title", "pm_new_meeting", "pm_join_with_code", "pm_join_meeting", "pm_code_or_link_label",
                     "pm_code_invalid", "pm_paste", "pm_join", "pm_switch_title", "pm_switch_body",
                     "pm_switch_stay", "pm_switch_leave_and_join", "pm_notice_invalid_link", "pm_update_title", "pm_empty_title"] {
            #expect(xml.contains("<string name=\"\(name)\">"), "missing \(name)")
        }
        #expect(xml.contains("<string name=\"pm_switch_body\">You\u{2019}re in %1$s. Leave it and join %2$s?</string>"))
    }
}

private func ent2Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func ent2Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
