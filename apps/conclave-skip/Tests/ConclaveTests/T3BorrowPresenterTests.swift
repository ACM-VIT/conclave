#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// The test clock: the presenter reads `ChatPoliciesTests.base + value` milliseconds.
final class T3BClock {
    var value = 0.0
}

/// A controlled sleep: each call records its duration and waits until the test wakes that duration, so a test decides
/// which pending task runs and when (the presenter's gate line task and the fixture driver's script pauses).
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

    /// Resumes every sleep that asked for `millis`.
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

/// T3B-3 (R/t3-borrow/PLAN.md section 4; P7, the presenter half of P4, P8): the Skip-safe `DelayedStatusPolicy`, the
/// presenter's delayed gate line (`composer.gateLine`) with its one cancellable task on the injected clock and sleep,
/// the one-attachment guard and `canAcceptPhoto`, the fixture's new states and scripts, and the timeline's composer
/// focus follow (source scans; the Kotlin half and the Robolectric list test are T/Skip/T3BorrowTimelineTests.kt).
@MainActor
struct T3BorrowPresenterTests {
    static let base = ChatPoliciesTests.base
    static let firstPhoto = "file:///cache/chat-photos/first.jpg"

    static func inputs(gate: ChatSendGate, attachment: ChatAttachmentState = .none, photosEnabled: Bool = true) -> ChatInputs {
        ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: ChatPoliciesTests.local, localName: "Jordan Lee",
                        messages: [], photosEnabled: photosEnabled, gate: gate, roster: ChatPoliciesTests.roster(),
                        assistant: .available, attachment: attachment)
    }

    /// A presenter on the test clock whose gate line task sleeps on the controlled sleeper.
    static func presenter(clock: T3BClock, sleeper: T3BSleeper, gate: ChatSendGate = .allowed) -> ChatPresenter {
        let chat = ChatPresenter()
        chat.now = { base + clock.value }
        chat.sleep = { millis in await sleeper.sleep(millis) }
        chat.apply(inputs(gate: gate), change: .messages)
        return chat
    }

    /// Lets tasks the test started or resumed run on the main actor.
    static func settle() async {
        for _ in 0..<5 {
            await Task.yield()
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }

    // MARK: P7 DelayedStatusPolicy (pure)

    @Test func theDelayedStatusPolicyWaitsHoldsAndRestamps() {
        let policy = DelayedStatusPolicy.self
        #expect(policy.showDelayMillis == 400 && policy.minimumVisibleMillis == 400)
        // A 250 ms blip never shows.
        var status = policy.step(.idle, value: "reconnecting", isImmediate: false, now: 0)
        #expect(status == DelayedStatus(phase: .pending, value: "reconnecting", deadline: 400))
        #expect(policy.visible(status) == "")
        status = policy.step(status, value: "", isImmediate: false, now: 250)
        #expect(status == .idle)
        // A 1,500 ms outage shows from 400 ms (the minimum hold ends at 800 ms) and hides when it ends.
        status = policy.step(.idle, value: "reconnecting", isImmediate: false, now: 0)
        status = policy.step(status, value: "reconnecting", isImmediate: false, now: 399)
        #expect(status.phase == .pending && status.deadline == 400)
        status = policy.step(status, value: "reconnecting", isImmediate: false, now: 400)
        #expect(status == DelayedStatus(phase: .shown, value: "reconnecting", deadline: 800))
        #expect(policy.visible(status) == "reconnecting")
        #expect(policy.step(status, value: "reconnecting", isImmediate: false, now: 1000) == status)
        #expect(policy.step(status, value: "", isImmediate: false, now: 1500) == .idle)
        // Reopened during the hold: the line stays until the hold ends.
        var held = policy.step(status, value: "", isImmediate: false, now: 600)
        #expect(held == status && policy.wakeDeadline(held, value: "", now: 600) == 800)
        held = policy.step(held, value: "", isImmediate: false, now: 800)
        #expect(held == .idle)
        // Reconnecting to offline while shown replaces the value at once and re-stamps the hold.
        var restamped = policy.step(status, value: "offline", isImmediate: false, now: 600)
        #expect(restamped == DelayedStatus(phase: .shown, value: "offline", deadline: 1000))
        restamped = policy.step(restamped, value: "", isImmediate: false, now: 700)
        #expect(restamped.value == "offline" && policy.wakeDeadline(restamped, value: "", now: 700) == 1000)
        // A different value while pending keeps the original show time.
        let pending = DelayedStatus(phase: .pending, value: "reconnecting", deadline: 400)
        #expect(policy.step(pending, value: "offline", isImmediate: false, now: 200)
                == DelayedStatus(phase: .pending, value: "offline", deadline: 400))
        // Immediate values show and clear at once, with no hold.
        let locked = policy.step(.idle, value: "locked", isImmediate: true, now: 50)
        #expect(locked == DelayedStatus(phase: .shown, value: "locked", deadline: 50))
        #expect(policy.step(locked, value: "", isImmediate: false, now: 50) == .idle)
        #expect(policy.step(status, value: "", isImmediate: true, now: 500) == .idle)
        #expect(policy.step(locked, value: "locked", isImmediate: true, now: 90) == locked)
        // Wakes: pending wakes at its show time; a value that is still wanted needs none.
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
        // The Android copy agrees: exactly the drawn gates have a line (ChatCopyAndroid.gateLine; iOS ChatCopy.gateLine
        // is the same table).
        let android = try chatSource("Sources/Conclave/Skip/ui/chat/ChatSnapshots.kt")
        #expect(android.contains("ChatSendGate.reconnecting -> conclaveString(\"chat_gate_reconnecting\")"))
        #expect(android.contains("ChatSendGate.offline -> conclaveString(\"chat_gate_offline\")"))
        #expect(android.contains("ChatSendGate.notJoined -> conclaveString(\"chat_gate_not_joined\")"))
    }

    // MARK: P7 presenter gate line (injected clock and sleep)

    @Test func theFirstApplyIsImmediateAndTheLineStartsEqualToTheGate() {
        #expect(ChatComposerSnapshot.initial.gateLine == ChatComposerSnapshot.initial.gate)
        #expect(ChatComposerSnapshot.initial.gateLine == .notJoined)
        let clock = T3BClock()
        let sleeper = T3BSleeper()
        let reconnecting = Self.presenter(clock: clock, sleeper: sleeper, gate: .reconnecting)
        #expect(reconnecting.composer.gate == .reconnecting && reconnecting.composer.gateLine == .reconnecting)
        #expect(!reconnecting.hasGateLineTask && reconnecting.gateLineTasksStarted == 0)
        // R8 first apply: a line drawn at once by the first apply counts as one show in the readout.
        #expect(reconnecting.gateLineShowCount == 1)
        let open = Self.presenter(clock: clock, sleeper: sleeper, gate: .allowed)
        #expect(open.composer.gateLine == .allowed && !open.hasGateLineTask && open.gateLineShowCount == 0)
        let locked = Self.presenter(clock: clock, sleeper: sleeper, gate: .locked)
        #expect(locked.composer.gateLine == .locked)
        // reset(): back to the initial snapshot, and the next apply is immediate again.
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
        // An outage the lock masked (locked outranks offline and reconnecting) shows at once when the lock lifts: it
        // is not a new blip. It still holds 400 ms like any drawn line.
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

    // MARK: P4 one attachment at a time (presenter half)

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
        // Every phase but none refuses; Remove frees the composer again.
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

    // MARK: Fixtures (R1, R2, R7, R8)

    @Test func theFixtureAddsTheDraftStatesAndThePhotoScript() {
        defer {
            ChatDiagnostics.driver = nil
            ChatDiagnostics.counters = nil
        }
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
        // photoTwice: one chip, the notice and one attachPhoto in the log.
        let shell = MeetingShellPresenter()
        let driver = ChatFixtureDriver.installOnStage(state: .busy, shell: shell)
        driver.run(.photoTwice)
        #expect(shell.chat.composer.attachment.phase == .preparing && shell.chat.composer.inlineNotice == .oneAttachment)
        #expect(driver.actionsReadout.components(separatedBy: "\n").filter { $0.hasPrefix("attachPhoto") }.count == 1)
        // The attach script still replaces the uploading photo of chat-attachment-uploading (Remove, then pick).
        let uploadingShell = MeetingShellPresenter()
        let uploading = ChatFixtureDriver.installOnStage(state: .attachmentUploading, shell: uploadingShell)
        uploading.run(.attachPhoto)
        #expect(uploadingShell.chat.composer.attachment.phase == .preparing)
        #expect(uploading.actionsReadout.contains("removeAttachment") && uploading.actionsReadout.contains("attachPhoto"))
    }

    @Test func gateBlipDrawsNoLineAndGateLongDrawsAndHoldsIt() async {
        defer {
            ChatDiagnostics.driver = nil
            ChatDiagnostics.counters = nil
        }
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

    @Test func theFixtureBarsShowTheGateLineReadout() throws {
        let ios = try chatSource("Sources/Conclave/Features/Meeting/Chat/Debug/ChatFixtureView+iOS.swift")
        #expect(ios.contains(".accessibilityIdentifier(\"chat.composer.gateLine\")") && ios.contains("driver.gateLineReadout"))
        let kotlin = try chatSource("Sources/Conclave/Skip/ui/chat/debug/ChatFixtureControls.kt")
        #expect(kotlin.contains("testTag(\"chat.composer.gateLine\")") && kotlin.contains("driver.gateLineReadout"))
    }

    // MARK: P8 composer focus follow (sources; the Robolectric list test is Kotlin)

    @Test func theTimelineFollowsComposerFocusOnlyWhenTheNewestRowIsVisible() throws {
        let timeline = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatTimeline+iOS.swift")
        #expect(timeline.components(separatedBy: ".onChange(of: actions.composerFocusRevision)").count - 1 == 1)
        #expect(timeline.contains("let follows = visibility.isVisible(newest)") && timeline.contains("guard follows else { return }"))
        #expect(timeline.contains("onScrollVisibilityChange(threshold: ChatRowVisibilityBox.partlyVisibleThreshold)"))
        #expect(timeline.contains(".onAppear { box.setVisible(rowId, true) }") && timeline.contains(".onDisappear { box.setVisible(rowId, false) }"))
        #expect(timeline.contains(".modifier(ChatRowVisibilityProbe(rowId: rowId, box: visibility))"))
        #expect(timeline.contains("withAnimation(.snappy) { proxy.scrollTo(newest, anchor: .bottom) }"))
        #expect(timeline.contains("if reduceMotion {\n            proxy.scrollTo(newest, anchor: .bottom)"))
        // iOS 17 only: the keyboard-settle re-pin, cleared when the keyboard hides.
        #expect(timeline.contains("visibility.repinsAfterKeyboard = follows && !ChatTimelinePlatform.usesScrollGeometry"))
        #expect(timeline.contains("UIResponder.keyboardDidShowNotification") && timeline.contains("UIResponder.keyboardWillHideNotification"))
        // The visibility box is plain state: no observed write from a visibility or appearance callback.
        #expect(timeline.contains("private final class ChatRowVisibilityBox {") && !timeline.contains("@Observable"))
        // Existing anchors stay (ChatPoliciesTests, CHT7AssistantRowTests).
        #expect(timeline.contains("ChatStreamingFollow17(chat: chat, proxy: proxy, isAtBottom: isAtBottom)"))
        #expect(timeline.contains(".defaultScrollAnchor(.bottom)") && timeline.contains(".scrollDismissesKeyboard(.interactively)"))
        let panel = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatPanel+iOS.swift")
        #expect(panel.contains("private(set) var composerFocusRevision = 0"))
        #expect(panel.contains("func composerDidFocus() {\n        composerFocusRevision += 1"))
        let kotlinTimeline = try chatSource("Sources/Conclave/Skip/ui/chat/ChatTimeline.kt")
        #expect(kotlinTimeline.contains("ChatComposerFocusFollow(listState, reduceMotion) { actions.composerFocusRevision }"))
        #expect(kotlinTimeline.contains("listState.layoutInfo.visibleItemsInfo.any { it.index == 0 }"))
        #expect(kotlinTimeline.contains("if (reduceMotion) listState.scrollToItem(0) else listState.animateScrollToItem(0)"))
        #expect(kotlinTimeline.contains("reverseLayout = true") && kotlinTimeline.contains("imeNestedScroll()"))
        let snapshots = try chatSource("Sources/Conclave/Skip/ui/chat/ChatSnapshots.kt")
        #expect(snapshots.contains("var composerFocusRevision by mutableIntStateOf(0)\n        private set"))
        #expect(snapshots.contains("fun composerDidFocus() {\n        composerFocusRevision += 1"))
    }

    // MARK: Rules (Skip limits, design laws)

    @Test func theT3BorrowSourcesStayInsideTheRules() throws {
        let files = [
            "Sources/Conclave/Features/Meeting/Chat/ChatDelayedGate.swift",
            "Sources/Conclave/Features/Meeting/Chat/ChatPresenter.swift",
            "Sources/Conclave/Features/Meeting/Chat/ChatModels.swift",
            "Sources/Conclave/Features/Meeting/Chat/ChatTimeline+iOS.swift",
            "Sources/Conclave/Features/Meeting/Chat/ChatPanel+iOS.swift",
            "Sources/Conclave/Features/Meeting/Chat/Debug/ChatFixtures.swift",
            "Sources/Conclave/Features/Meeting/Chat/Debug/ChatFixtureView+iOS.swift",
            "Sources/Conclave/Skip/ui/chat/ChatTimeline.kt",
            "Sources/Conclave/Skip/ui/chat/ChatSnapshots.kt",
            "Sources/Conclave/Skip/ui/chat/debug/ChatFixtureControls.kt",
        ]
        for file in files {
            let text = try chatSource(file)
            #expect(!chatHasDash(text), "\(file) contains an en or em dash")
            for forbidden in ["Gradient", "gradient", "sensoryFeedback", "performHapticFeedback", "conclaveGestureFeedback",
                              "glassEffect", "UIImpactFeedbackGenerator"] {
                #expect(!text.contains(forbidden), "\(file) uses \(forbidden)")
            }
        }
        // The shared policy is Skip safe: String raw-value enums, scalar structs, no tuples, no timers.
        let policy = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatDelayedGate.swift")
        #expect(policy.contains("enum DelayedStatusPhase: String, CaseIterable {"))
        #expect(policy.contains("struct DelayedStatus: Equatable {") && policy.contains("enum DelayedStatusPolicy {"))
        #expect(!policy.contains("-> (") && !policy.contains("Task") && !policy.contains("Timer") && !policy.contains("import SwiftUI"))
        // One stored, cancellable gate line task on the injected sleep, cancelled by reset.
        let presenter = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatPresenter.swift")
        #expect(presenter.components(separatedBy: "gateLineTask = Task {").count - 1 == 1)
        #expect(presenter.contains("let wait = sleep\n        let delay = max(0.0, wake - time)"))
        #expect(presenter.contains("gateLine: currentGateLine,") && presenter.contains("current.gateLine == next.gateLine"))
        #expect(presenter.contains("// P7: the gate line task is cancelled, and the next apply is immediate again.\n        gateLineTask?.cancel()"))
    }
}
#endif
