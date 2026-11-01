#if !SKIP
import Foundation
import Testing
@testable import Conclave

final class T3BClock {
    var value = 0.0
}

@MainActor
final class T3BSleeper {
    private(set) var requested: [Double] = []
    private var waitingMillis: [Double] = []
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func sleep(_ millis: Double) async {
        requested.append(millis)
        await withCheckedContinuation { continuation in
            waitingMillis.append(millis)
            waiting.append(continuation)
        }
    }

    func wake(_ millis: Double) {
        var keptMillis: [Double] = []
        var kept: [CheckedContinuation<Void, Never>] = []
        var resumed: [CheckedContinuation<Void, Never>] = []
        var index = 0
        while index < waiting.count {
            if waitingMillis[index] == millis {
                resumed.append(waiting[index])
            } else {
                keptMillis.append(waitingMillis[index])
                kept.append(waiting[index])
            }
            index += 1
        }
        waitingMillis = keptMillis
        waiting = kept
        for continuation in resumed {
            continuation.resume()
        }
    }

    func wakeAll() {
        let all = waiting
        waitingMillis = []
        waiting = []
        for continuation in all {
            continuation.resume()
        }
    }
}

@MainActor
struct T3BorrowPresenterTests {
    static let base = ChatPoliciesTests.base
    static let firstPhoto = "file:///cache/chat-photos/first.jpg"

    static func inputs(gate: ChatSendGate, attachment: ChatAttachmentState = .none, photosEnabled: Bool = true) -> ChatInputs {
        ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: ChatPoliciesTests.local, localName: "Jordan Lee",
                        messages: [], photosEnabled: photosEnabled, gate: gate, roster: ChatPoliciesTests.roster(),
                        assistant: .available, attachment: attachment)
    }

    static func presenter(clock: T3BClock, sleeper: T3BSleeper, gate: ChatSendGate = .allowed) -> ChatPresenter {
        let chat = ChatPresenter()
        chat.now = { base + clock.value }
        chat.sleep = { millis in await sleeper.sleep(millis) }
        chat.apply(inputs(gate: gate), change: .messages)
        return chat
    }

    static func settle() async {
        for _ in 0..<5 {
            await Task.yield()
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }

    @Test func theDelayedStatusPolicyWaitsHoldsAndRestamps() {
        let policy = DelayedStatusPolicy.self
        #expect(policy.showDelayMillis == 400 && policy.minimumVisibleMillis == 400)

        var status = policy.step(.idle, value: "reconnecting", isImmediate: false, now: 0)
        #expect(status == DelayedStatus(phase: .pending, value: "reconnecting", deadline: 400))
        #expect(policy.visible(status) == "")
        status = policy.step(status, value: "", isImmediate: false, now: 250)
        #expect(status == .idle)

        status = policy.step(.idle, value: "reconnecting", isImmediate: false, now: 0)
        status = policy.step(status, value: "reconnecting", isImmediate: false, now: 399)
        #expect(status.phase == .pending && status.deadline == 400)
        status = policy.step(status, value: "reconnecting", isImmediate: false, now: 400)
        #expect(status == DelayedStatus(phase: .shown, value: "reconnecting", deadline: 800))
        #expect(policy.visible(status) == "reconnecting")
        #expect(policy.step(status, value: "reconnecting", isImmediate: false, now: 1000) == status)
        #expect(policy.step(status, value: "", isImmediate: false, now: 1500) == .idle)

        var held = policy.step(status, value: "", isImmediate: false, now: 600)
        #expect(held == status && policy.wakeDeadline(held, value: "", now: 600) == 800)
        held = policy.step(held, value: "", isImmediate: false, now: 800)
        #expect(held == .idle)

        var restamped = policy.step(status, value: "offline", isImmediate: false, now: 600)
        #expect(restamped == DelayedStatus(phase: .shown, value: "offline", deadline: 1000))
        restamped = policy.step(restamped, value: "", isImmediate: false, now: 700)
        #expect(restamped.value == "offline" && policy.wakeDeadline(restamped, value: "", now: 700) == 1000)

        let pending = DelayedStatus(phase: .pending, value: "reconnecting", deadline: 400)
        #expect(policy.step(pending, value: "offline", isImmediate: false, now: 200)
                == DelayedStatus(phase: .pending, value: "offline", deadline: 400))

        let locked = policy.step(.idle, value: "locked", isImmediate: true, now: 50)
        #expect(locked == DelayedStatus(phase: .shown, value: "locked", deadline: 50))
        #expect(policy.step(locked, value: "", isImmediate: false, now: 50) == .idle)
        #expect(policy.step(status, value: "", isImmediate: true, now: 500) == .idle)
        #expect(policy.step(locked, value: "locked", isImmediate: true, now: 90) == locked)

        #expect(policy.wakeDeadline(pending, value: "reconnecting", now: 0) == 400)
        #expect(policy.wakeDeadline(restamped, value: "offline", now: 700) == -1)
        #expect(policy.wakeDeadline(.idle, value: "", now: 0) == -1)
    }

    @Test func theGateLinePolicyNamesTheDrawnAndImmediateGates() throws {
        #expect(ChatGateLinePolicy.showsLine(.notJoined) && ChatGateLinePolicy.showsLine(.reconnecting)
                && ChatGateLinePolicy.showsLine(.offline))
        #expect(!ChatGateLinePolicy.showsLine(.allowed) && !ChatGateLinePolicy.showsLine(.locked)
                && !ChatGateLinePolicy.showsLine(.attendee))
        #expect(ChatGateLinePolicy.isImmediate(.locked) && ChatGateLinePolicy.isImmediate(.attendee))
        #expect(!ChatGateLinePolicy.isImmediate(.reconnecting) && !ChatGateLinePolicy.isImmediate(.offline))
        #expect(ChatGateLinePolicy.statusValue(.allowed) == "" && ChatGateLinePolicy.statusValue(.offline) == "offline")
    }

    @Test func theFirstApplyIsImmediateAndTheLineStartsEqualToTheGate() {
        #expect(ChatComposerSnapshot.initial.gateLine == ChatComposerSnapshot.initial.gate)
        #expect(ChatComposerSnapshot.initial.gateLine == .notJoined)
        let clock = T3BClock()
        let sleeper = T3BSleeper()
        let reconnecting = Self.presenter(clock: clock, sleeper: sleeper, gate: .reconnecting)
        #expect(reconnecting.composer.gate == .reconnecting && reconnecting.composer.gateLine == .reconnecting)
        #expect(!reconnecting.hasGateLineTask && reconnecting.gateLineTasksStarted == 0)

        #expect(reconnecting.gateLineShowCount == 1)
        let open = Self.presenter(clock: clock, sleeper: sleeper, gate: .allowed)
        #expect(open.composer.gateLine == .allowed && !open.hasGateLineTask && open.gateLineShowCount == 0)
        let locked = Self.presenter(clock: clock, sleeper: sleeper, gate: .locked)
        #expect(locked.composer.gateLine == .locked)

        reconnecting.reset()
        #expect(reconnecting.composer == ChatComposerSnapshot.initial)
        #expect(reconnecting.gateLineShowCount == 0 && reconnecting.gateLineTasksStarted == 0, "reset clears the readout counters")
        reconnecting.apply(Self.inputs(gate: .offline), change: .messages)
        #expect(reconnecting.composer.gateLine == .offline && !reconnecting.hasGateLineTask)
        #expect(reconnecting.gateLineShowCount == 1)
    }

    @Test func aBlipNeverDrawsTheLineAndPublishesTheComposerOnlyForTheGate() async {
        let clock = T3BClock()
        let sleeper = T3BSleeper()
        let chat = Self.presenter(clock: clock, sleeper: sleeper)
        let publishes = chat.composerPublishCount
        chat.apply(Self.inputs(gate: .reconnecting), change: .gate)
        #expect(chat.composer.gate == .reconnecting, "Send follows the gate at once")
        #expect(!ChatComposerPolicy.canSend(text: "hi", gate: chat.composer.gate, isVoiceMode: false,
                                            attachment: chat.composer.attachment))
        #expect(chat.composer.gateLine == .allowed && chat.hasGateLineTask)
        await Self.settle()
        #expect(sleeper.requested == [400])
        clock.value = 250
        chat.apply(Self.inputs(gate: .allowed), change: .gate)
        #expect(chat.composer.gate == .allowed && chat.composer.gateLine == .allowed)
        #expect(!chat.hasGateLineTask, "the blip cancels the task")
        #expect(chat.composerPublishCount - publishes == 2, "one publish per gate change, none for the line")
        sleeper.wakeAll()
        await Self.settle()
        #expect(chat.composer.gateLine == .allowed && chat.gateLineShowCount == 0)
        #expect(chat.composerPublishCount - publishes == 2, "the cancelled task publishes nothing")
    }

    @Test func aLongOutageDrawsTheLineAfter400MillisecondsAndHidesItWhenItEnds() async {
        let clock = T3BClock()
        let sleeper = T3BSleeper()
        let chat = Self.presenter(clock: clock, sleeper: sleeper)
        chat.apply(Self.inputs(gate: .reconnecting), change: .gate)
        await Self.settle()
        let publishes = chat.composerPublishCount
        clock.value = 400
        sleeper.wake(400)
        await Self.settle()
        #expect(chat.composer.gateLine == .reconnecting && chat.gateLineShowCount == 1)
        #expect(chat.composerPublishCount - publishes == 1, "the line's own publish")
        #expect(!chat.hasGateLineTask, "a line that is still wanted needs no wake")
        clock.value = 1500
        chat.apply(Self.inputs(gate: .allowed), change: .gate)
        #expect(chat.composer.gate == .allowed && chat.composer.gateLine == .allowed, "the hold ended at 800 ms")
        #expect(chat.gateLineTasksStarted == 1 && !chat.hasGateLineTask)
    }

    @Test func aGateThatReopensDuringTheHoldKeepsTheLineUntilTheHoldEnds() async {
        let clock = T3BClock()
        let sleeper = T3BSleeper()
        let chat = Self.presenter(clock: clock, sleeper: sleeper)
        chat.apply(Self.inputs(gate: .reconnecting), change: .gate)
        await Self.settle()
        clock.value = 400
        sleeper.wake(400)
        await Self.settle()
        clock.value = 600
        chat.apply(Self.inputs(gate: .allowed), change: .gate)
        #expect(chat.composer.gate == .allowed && chat.composer.gateLine == .reconnecting)
        #expect(chat.send(text: "back online") == .dispatched, "Send follows the real gate during the hold")
        #expect(chat.hasGateLineTask)
        await Self.settle()
        #expect(sleeper.requested.last == 200)
        clock.value = 800
        sleeper.wake(200)
        await Self.settle()
        #expect(chat.composer.gateLine == .allowed && !chat.hasGateLineTask)
    }

    @Test func reconnectingToOfflineWhileDrawnRestampsTheHold() async {
        let clock = T3BClock()
        let sleeper = T3BSleeper()
        let chat = Self.presenter(clock: clock, sleeper: sleeper)
        chat.apply(Self.inputs(gate: .reconnecting), change: .gate)
        await Self.settle()
        clock.value = 400
        sleeper.wake(400)
        await Self.settle()
        clock.value = 600
        chat.apply(Self.inputs(gate: .offline), change: .gate)
        #expect(chat.composer.gateLine == .offline && chat.gateLineShowCount == 1, "a new value while drawn replaces it at once")
        clock.value = 700
        chat.apply(Self.inputs(gate: .allowed), change: .gate)
        #expect(chat.composer.gateLine == .offline, "the re-stamped hold runs to 1,000 ms")
        await Self.settle()
        #expect(sleeper.requested.last == 300)
        clock.value = 1000
        sleeper.wake(300)
        await Self.settle()
        #expect(chat.composer.gateLine == .allowed)
    }

    @Test func lockedAndAttendeeAreNeverDelayed() {
        let chat = Self.presenter(clock: T3BClock(), sleeper: T3BSleeper())
        chat.apply(Self.inputs(gate: .locked), change: .gate)
        #expect(chat.composer.gateLine == .locked && !chat.hasGateLineTask)
        chat.apply(Self.inputs(gate: .allowed), change: .gate)
        #expect(chat.composer.gateLine == .allowed && !chat.hasGateLineTask)
        chat.apply(Self.inputs(gate: .attendee), change: .gate)
        #expect(chat.composer.gateLine == .attendee && !chat.hasGateLineTask)
        #expect(chat.gateLineShowCount == 0, "locked and attendee draw no line")
        #expect(chat.gateLineTasksStarted == 0)

        chat.apply(Self.inputs(gate: .locked), change: .gate)
        chat.apply(Self.inputs(gate: .offline), change: .gate)
        #expect(chat.composer.gateLine == .offline && chat.gateLineShowCount == 1)
        chat.apply(Self.inputs(gate: .allowed), change: .gate)
        #expect(chat.composer.gateLine == .offline && chat.hasGateLineTask)
    }

    @Test func resetCancelsTheGateLineTask() async {
        let clock = T3BClock()
        let sleeper = T3BSleeper()
        let chat = Self.presenter(clock: clock, sleeper: sleeper)
        chat.apply(Self.inputs(gate: .reconnecting), change: .gate)
        #expect(chat.hasGateLineTask)
        await Self.settle()
        chat.reset()
        #expect(!chat.hasGateLineTask && chat.composer == ChatComposerSnapshot.initial)
        let publishes = chat.composerPublishCount
        clock.value = 400
        sleeper.wakeAll()
        await Self.settle()
        #expect(chat.composer == ChatComposerSnapshot.initial && chat.composerPublishCount == publishes,
                "the cancelled task changes nothing")
        chat.apply(Self.inputs(gate: .reconnecting), change: .messages)
        #expect(chat.composer.gateLine == .reconnecting, "the first apply after reset is immediate")
    }

    @Test func aSecondPhotoIsRefusedWithTheOneAttachmentNotice() {
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(Self.inputs(gate: .allowed))
        chat.onCommand = { log.append($0) }
        #expect(chat.canAcceptPhoto)
        chat.attachPhoto(fileURL: Self.firstPhoto, mimeType: "image/jpeg", fileName: "first.jpg")
        #expect(!chat.canAcceptPhoto)
        chat.attachPhoto(fileURL: "file:///cache/chat-photos/second.jpg", mimeType: "image/jpeg", fileName: "second.jpg")
        #expect(log.filter { $0.kind == .attachPhoto }.count == 1)
        #expect(chat.composer.inlineNotice == .oneAttachment)
        #expect(chat.composer.attachment.phase == .preparing && chat.composer.attachment.thumbnailKey == Self.firstPhoto)

        for phase in [ChatAttachmentPhase.uploading, .ready, .failed] {
            let state = ChatAttachmentState(phase: phase, progress: 0.5, thumbnailKey: Self.firstPhoto,
                                            failure: phase == .failed ? .photoUnavailable : .none)
            chat.apply(Self.inputs(gate: .allowed, attachment: state), change: .attachment)
            let before = log.count
            chat.attachPhoto(fileURL: "file:///cache/chat-photos/third.jpg", mimeType: "image/jpeg", fileName: "third.jpg")
            #expect(log.count == before && chat.composer.inlineNotice == .oneAttachment, "\(phase)")
            #expect(chat.composer.attachment.thumbnailKey == Self.firstPhoto && !chat.canAcceptPhoto, "\(phase)")
        }
        chat.removeAttachment()
        chat.apply(Self.inputs(gate: .allowed), change: .attachment)
        #expect(chat.canAcceptPhoto)
        chat.attachPhoto(fileURL: "file:///cache/chat-photos/third.jpg", mimeType: "image/jpeg", fileName: "third.jpg")
        #expect(log.last?.kind == .attachPhoto && chat.composer.inlineNotice == .none)
    }

    @Test func canAcceptPhotoNeedsAnOpenGateEveryoneModePhotosOnAndNoPhoto() {
        #expect(ChatPoliciesTests.presenter(Self.inputs(gate: .allowed)).canAcceptPhoto)
        for gate in [ChatSendGate.notJoined, .reconnecting, .offline, .locked, .attendee] {
            #expect(!ChatPoliciesTests.presenter(Self.inputs(gate: gate)).canAcceptPhoto, "\(gate)")
        }
        #expect(!ChatPoliciesTests.presenter(Self.inputs(gate: .allowed, photosEnabled: false)).canAcceptPhoto)
        let privateMode = ChatPoliciesTests.presenter(Self.inputs(gate: .allowed))
        privateMode.setPrivateTo(userId: ChatPoliciesTests.avery)
        #expect(!privateMode.canAcceptPhoto)
        privateMode.setPrivateTo(userId: "")
        #expect(privateMode.canAcceptPhoto)
        for phase in [ChatAttachmentPhase.preparing, .uploading, .ready, .failed] {
            let state = ChatAttachmentState(phase: phase, progress: 0, thumbnailKey: "file:///x.jpg", failure: .none)
            #expect(!ChatPoliciesTests.presenter(Self.inputs(gate: .allowed, attachment: state)).canAcceptPhoto, "\(phase)")
        }
    }

    @Test func theFixtureAddsTheDraftStatesAndThePhotoScript() async {
        await ChatFixtureTestGate.acquire()
        defer { ChatFixtureTestGate.release() }
        #expect(ChatFixtureDriver.state(named: "chat-draft-multiline") == .draftMultiline)
        #expect(ChatFixtureDriver.state(named: "chat-suggestions-mention-query") == .suggestionsMentionQuery)
        #expect(ChatFixtureScriptName(rawValue: "gateBlip") == .gateBlip && ChatFixtureScriptName(rawValue: "gateLong") == .gateLong)
        #expect(ChatFixtureScriptName(rawValue: "photoTwice") == .photoTwice)
        let multiline = ChatFixtureDriver.installOnStage(state: .draftMultiline, shell: MeetingShellPresenter())
        let draft = multiline.chat.drafts.text(for: multiline.chat.composer.draftKey)
        #expect(draft == ChatFixtureScript.multilineDraft && draft.components(separatedBy: "\n").count == 3)
        let query = ChatFixtureDriver.installOnStage(state: .suggestionsMentionQuery, shell: MeetingShellPresenter())
        #expect(query.chat.drafts.text(for: query.chat.composer.draftKey) == "@av")
        let mentions = ChatComposerPolicy.mentionSuggestions(draft: "@av", options: query.chat.composer.mentionOptions)
        #expect(mentions.first?.name == "Avery Lee", "Avery leads the filtered list")

        let shell = MeetingShellPresenter()
        let driver = ChatFixtureDriver.installOnStage(state: .busy, shell: shell)
        driver.run(.photoTwice)
        #expect(shell.chat.composer.attachment.phase == .preparing && shell.chat.composer.inlineNotice == .oneAttachment)
        #expect(driver.actionsReadout.components(separatedBy: "\n").filter { $0.hasPrefix("attachPhoto") }.count == 1)

        let uploadingShell = MeetingShellPresenter()
        let uploading = ChatFixtureDriver.installOnStage(state: .attachmentUploading, shell: uploadingShell)
        uploading.run(.attachPhoto)
        #expect(uploadingShell.chat.composer.attachment.phase == .preparing)
        #expect(uploading.actionsReadout.contains("removeAttachment") && uploading.actionsReadout.contains("attachPhoto"))
    }

    @Test func gateBlipDrawsNoLineAndGateLongDrawsAndHoldsIt() async {
        await ChatFixtureTestGate.acquire()
        defer { ChatFixtureTestGate.release() }
        let clock = T3BClock()
        let sleeper = T3BSleeper()
        let blipShell = MeetingShellPresenter()
        let blip = ChatFixtureDriver.installOnStage(state: .busy, shell: blipShell)
        blipShell.chat.now = { Self.base + clock.value }
        blipShell.chat.sleep = { millis in await sleeper.sleep(millis) }
        blip.sleep = { millis in await sleeper.sleep(millis) }
        #expect(blip.gateLineReadout == "gateLine=open gate=open shows=0")
        blip.run(.gateBlip)
        #expect(blipShell.chat.composer.gate == .reconnecting && blipShell.chat.composer.gateLine == .allowed)
        await Self.settle()
        #expect(sleeper.requested.contains(250) && sleeper.requested.contains(400))
        clock.value = 250
        sleeper.wake(250)
        await Self.settle()
        #expect(blip.gateLineReadout == "gateLine=open gate=open shows=0")
        sleeper.wake(400)
        await Self.settle()
        #expect(blip.gateLineReadout == "gateLine=open gate=open shows=0", "the cancelled task draws nothing")

        let longClock = T3BClock()
        let longSleeper = T3BSleeper()
        let longShell = MeetingShellPresenter()
        let long = ChatFixtureDriver.installOnStage(state: .busy, shell: longShell)
        longShell.chat.now = { Self.base + longClock.value }
        longShell.chat.sleep = { millis in await longSleeper.sleep(millis) }
        long.sleep = { millis in await longSleeper.sleep(millis) }
        long.run(.gateLong)
        await Self.settle()
        longClock.value = 400
        longSleeper.wake(400)
        await Self.settle()
        #expect(long.gateLineReadout == "gateLine=reconnecting gate=reconnecting shows=1")
        longClock.value = 1500
        longSleeper.wake(1500)
        await Self.settle()
        #expect(long.gateLineReadout == "gateLine=open gate=open shows=1")
    }

}
#endif
