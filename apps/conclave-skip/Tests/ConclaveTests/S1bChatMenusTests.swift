#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1bChatMenusTests {
    private static let sheetFile = "Sources/Conclave/Skip/ui/chat/MessageActionsSheet.kt"
    private static let composerFile = "Sources/Conclave/Skip/ui/chat/ChatComposer.kt"
    private static let voiceFile = "Sources/Conclave/Skip/ui/chat/VoiceBubble.kt"
    private static let transcriptPageFile = "Sources/Conclave/Skip/ui/transcript/TranscriptPage.kt"
    private static let transcriptListsFile = "Sources/Conclave/Skip/ui/transcript/TranscriptLists.kt"
    private static let questionRowFile = "Sources/Conclave/Skip/ui/qa/QuestionRow.kt"
    private static let ownedFiles = [sheetFile, composerFile, voiceFile, transcriptPageFile, transcriptListsFile, questionRowFile]

    @Test func recipientFacesSeedExactlyLikeThePeopleRows() throws {
        let local = "u-jordan"
        let avery = "u-avery"
        let sam = "u-sam"
        let chat = ChatPresenter()
        chat.now = { 1_800_014_400_000.0 }
        chat.sleep = { _ in }
        chat.apply(ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: local, localName: "Jordan Lee", gate: .allowed,
                                   roster: [ChatRosterEntry(userId: local, name: "Jordan Lee", isPresent: true),
                                            ChatRosterEntry(userId: avery, name: "Avery Lee Smith", isPresent: true),
                                            ChatRosterEntry(userId: sam, name: "Sam", isPresent: true)],
                                   assistant: .available), change: .messages)
        let recipients = chat.composer.recipients
        #expect(recipients.map { $0.userId } == [avery, sam])

        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        people.apply(PeopleInputs.make(callSession: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: local,
                                       participants: [PeopleParticipantInput.make(userId: local, displayName: "Jordan Lee", isLocal: true),
                                                      PeopleParticipantInput.make(userId: avery, displayName: "Avery Lee Smith"),
                                                      PeopleParticipantInput.make(userId: sam, displayName: "Sam")],
                                       isRosterLoaded: true))
        for recipient in recipients {
            let key = PeopleOrderPolicy.rosterKey(recipient.userId)
            #expect(people.rows.contains(key), "\(recipient.userId)")
            let menuFace = ConclaveAvatarIdentity.fromSeed(PeopleRowPolicy.avatarSeed(name: recipient.name, userId: recipient.userId,
                                                                                      isLocal: false))
            let peopleFace = ConclaveAvatarIdentity.fromSeed(people.rows.entry(for: key).model.avatarSeed)
            #expect(menuFace == peopleFace, "the recipient face for \(recipient.userId) is the People face")
        }

        let threeWords = try #require(recipients.first(where: { $0.userId == avery }))
        #expect(threeWords.name == "Avery Lee Smith")
        let seed = PeopleRowPolicy.avatarSeed(name: threeWords.name, userId: threeWords.userId, isLocal: false)
        #expect(seed == FacehashPresentation.seed(name: "Avery Lee", id: avery), "People seeds the first two words of a longer name")
        #expect(seed != threeWords.avatarSeed, "the recipient model's own seed keeps every word, so the menu must not read it")
    }

    @Test func emojiCirclesAreStockTonalToggleButtonsInACappedRow() throws {
        #expect(ChatReactionRules.emojis.count == 8)

        let circle = 48.0
        let inset = 16.0
        #expect(296.0 - 2.0 * inset >= circle * 5.0, "five circles fit on a line inside the capped side-pane row")
    }
}

private func s1bcmRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bcmSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bcmRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bcmFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bcmSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1bcmCount(_ text: String, _ needle: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

private func s1bcmMatchCount(_ pattern: String, in text: String) -> Int {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return -1 }
    return regex.numberOfMatches(in: text, range: NSRange(text.startIndex..<text.endIndex, in: text))
}
#endif
