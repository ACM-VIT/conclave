#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1bChatMenusTests {
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

        let shell = MeetingShellPresenter(defaults: IsolatedDefaults.make())
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
}
#endif
