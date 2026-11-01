#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ChatComposerFeelTests {
    private func affordance(_ kind: String, gate: ChatSendGate = .allowed, isPrivate: Bool = false, photos: Bool = true,
                            attached: Bool = false) -> ChatAttachAffordance {
        ChatComposerPolicy.attachAffordance(kind: kind, gate: gate, isPrivateMode: isPrivate, photosEnabled: photos,
                                            hasAttachment: attached)
    }

    @Test func attachButtonsOpenTheirPickerDirectlyWhenNothingBlocksThem() {
        for kind in ChatComposerPolicy.attachKinds {
            let open = affordance(kind)
            #expect(open.isEnabled && open.opens && open.notice == .none, "\(kind)")
        }
    }

    @Test func aBlockedAttachButtonExplainsItselfInsteadOfOpening() {
        #expect(affordance("photo", isPrivate: true) == ChatAttachAffordance(isEnabled: true, opens: false, notice: .privateTextOnly))
        #expect(affordance("gif", isPrivate: true) == ChatAttachAffordance(isEnabled: true, opens: false, notice: .privateTextOnly))
        #expect(affordance("photo", photos: false) == ChatAttachAffordance(isEnabled: true, opens: false, notice: .photosDisabled))
        #expect(affordance("gif", photos: false).opens, "GIFs stay allowed when photos are off")
        #expect(affordance("photo", attached: true) == ChatAttachAffordance(isEnabled: true, opens: false, notice: .oneAttachment))
        #expect(affordance("gif", attached: true).opens, "a GIF sends on its own, so a pending photo does not block the picker")
    }

    @Test func aClosedSendGateDisablesAttachWithoutANoticeBecauseTheGateLineAlreadySaysWhy() {
        for gate in [ChatSendGate.notJoined, .reconnecting, .offline, .locked, .attendee] {
            for kind in ChatComposerPolicy.attachKinds {
                #expect(affordance(kind, gate: gate) == ChatAttachAffordance(isEnabled: false, opens: false, notice: .none),
                        "\(gate) \(kind)")
            }
        }
    }

    @Test func theAttachAffordanceAgreesWithTheNoticeAPastedPhotoGets() {
        for isPrivate in [false, true] {
            for photos in [false, true] {
                for attached in [false, true] {
                    let pasted = ChatComposerPolicy.photoIntakeNotice(gate: .allowed, isPrivateMode: isPrivate, photosEnabled: photos,
                                                                      hasAttachment: attached, inFlight: false)
                    #expect(affordance("photo", isPrivate: isPrivate, photos: photos, attached: attached).notice == pasted)
                }
            }
        }
    }

    @Test func voiceMessagesLeaveTheAttachButtonButStayReachableThroughTts() {
        #expect(ChatComposerPolicy.attachKinds == ["photo", "gif"])
        let chat = ChatPoliciesTests.presenter(ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: ChatPoliciesTests.local,
                                                                localName: "Jordan Lee", messages: [], photosEnabled: true,
                                                                gate: .allowed, roster: ChatPoliciesTests.roster(),
                                                                assistant: .available, attachment: .none))
        var log: [String] = []
        chat.onCommand = { log.append($0.logLine) }
        #expect(!chat.composer.attachKinds.contains("voice"))
        #expect(VoiceMessagePolicy.showsComposerRow(isVoiceMode: false, draft: "/tts hello there", isPrivateMode: false,
                                                    voiceEnabled: true))
        #expect(chat.send(text: "/tts hello there") == .dispatched)
        #expect(log.last?.hasSuffix("text=/tts hello there") == true)
    }
}
#endif
