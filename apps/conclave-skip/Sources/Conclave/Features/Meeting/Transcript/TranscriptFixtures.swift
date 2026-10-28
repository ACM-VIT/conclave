import Foundation

enum TranscriptFixtureState: String, CaseIterable, Equatable {
    case idle = "transcript-idle"
    case viewOnly = "transcript-viewonly"
    case takeover = "transcript-takeover"
    case liveController = "transcript-live-controller"
    case liveFollower = "transcript-live-follower"
    case paused = "transcript-paused"
    case reconnecting = "transcript-reconnecting"
    case unavailable = "transcript-unavailable"
    case ended = "transcript-ended"
    case relayUnavailable = "transcript-relay-unavailable"

    case long = "transcript-long"

    case ask = "transcript-ask"

    case minutes = "transcript-minutes"
}

enum TranscriptFixtureScriptName: String, CaseIterable, Equatable {

    case stream10 = "stream:10"

    case growFiveLines

    case stopFails

    case askReject

    case askSilence

    case recapFails
    case resetCounters
}

final class TranscriptFixtureCounters {
    private(set) var counts: [String: Int] = [:]

    init() {}

    func bump(_ key: String) {
        counts[key] = (counts[key] ?? 0) + 1
    }

    func count(_ key: String) -> Int {
        counts[key] ?? 0
    }

    func reset() {
        counts = [:]
    }
}

enum TranscriptDiagnostics {
    static var counters: TranscriptFixtureCounters? = nil
    static var driver: TranscriptFixtureDriver? = nil

    @MainActor
    static func readout() -> String {
        guard let driver = driver else { return "transcript none" }
        return driver.readout()
    }
}

enum TranscriptFixtureScript {
    static let localUserId = "jordan@example.com#fixture"
    static let localName = "Jordan Lee"
    static let averyId = "avery@example.com#web-1"
    static let samId = "sam@example.com#web-2"
    static let roomId = "fixture-room"

    static let baseMillis = 1_793_101_260_000.0

    static let sentences: [String] = [
        "So the deck is ready for review by Friday.",
        "Great, I will send it to the design group after lunch.",
        "We still need the numbers for the second quarter.",
        "Priya said she can pull them from the dashboard tomorrow.",
        "Then we probably need to decide on the launch date.",
        "Let us keep the twelfth as the target and revisit next week."
    ]

    static func speaker(_ index: Int) -> String {
        switch index % 3 {
        case 0: return averyId
        case 1: return samId
        default: return localUserId
        }
    }

    static func name(_ userId: String) -> String {
        if userId == averyId { return "Avery Lee" }
        if userId == samId { return "Sam Rivera" }
        return localName
    }

    static func segment(_ index: Int, userId: String, startMs: Double, final: Bool, text: String) -> TranscriptSegmentModel {
        TranscriptSegmentModel(itemId: "seg-" + String(index), sequence: index, speakerUserId: userId, speakerDisplayName: name(userId),
                               text: text, startMs: startMs, isFinal: final)
    }

    static func finals(count: Int) -> [TranscriptSegmentModel] {
        var result: [TranscriptSegmentModel] = []
        var time = baseMillis
        var index = 0
        while index < count {
            let monologue = index >= count / 2 && index < count / 2 + 40
            let userId = monologue ? averyId : speaker(index / 2)
            time += index > 0 && index % 150 == 0 ? 240_000.0 : 20_000.0
            result.append(segment(index + 1, userId: userId, startMs: time, final: true, text: sentences[index % sentences.count]))
            index += 1
        }
        return result
    }

    static func minutes() -> TranscriptMinutesSnapshotModel {
        TranscriptMinutesSnapshotModel(
            summary: "The team reviewed the deck and agreed to keep the launch target.",
            topics: [TranscriptMinutesEntryModel(id: "t1", text: "Deck review", speakerUserId: nil, speakerDisplayName: nil, owner: nil, due: nil)],
            decisions: [TranscriptMinutesEntryModel(id: "d1", text: "Keep the twelfth as the launch target", speakerUserId: nil,
                                                    speakerDisplayName: nil, owner: nil, due: nil)],
            actionItems: [TranscriptMinutesEntryModel(id: "a1", text: "Send the deck to the design group", speakerUserId: nil,
                                                      speakerDisplayName: nil, owner: "Avery Lee", due: "Friday")],
            openQuestions: [TranscriptMinutesEntryModel(id: "q1", text: "Which numbers go in the appendix?", speakerUserId: nil,
                                                        speakerDisplayName: nil, owner: nil, due: nil)],
            followUps: [TranscriptMinutesEntryModel(id: "f1", text: "Revisit the date next week", speakerUserId: nil,
                                                    speakerDisplayName: nil, owner: "Sam Rivera", due: nil)],
            updatedAt: baseMillis + 120_000.0,
            model: TranscriptConfiguration.defaultAssistantModel)
    }

    static let answer = "Two decisions so far:\n\n- **Launch** stays on the twelfth.\n- The deck goes to design after lunch.\n\nAvery owns the deck."
}

@MainActor
final class TranscriptFixtureDriver {
    let fixture: TranscriptFixtureState
    let state = TranscriptState()
    let presenter: TranscriptPresenter
    let counters = TranscriptFixtureCounters()

    private(set) var stopFails = false
    private(set) var askMode = "answer"
    private(set) var recapFails = false
    private(set) var recap = RecapPhase.idle

    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    var runsFollowUps = true
    private var nextQuestion = 0
    private var nextSegment = 100_000

    init(fixture: TranscriptFixtureState, presenter: TranscriptPresenter? = nil) {
        self.fixture = fixture
        self.presenter = presenter ?? TranscriptPresenter()
        state.setLegacyPresentation(false)
        self.presenter.onCommand = { [weak self] command in
            guard let self = self else { return false }
            return self.perform(command)
        }
        seed()
        self.presenter.bind(state: state)
        applyInputs()
    }

    @discardableResult
    static func installOnStage(state: TranscriptFixtureState, shell: MeetingShellPresenter) -> TranscriptFixtureDriver {
        let driver = TranscriptFixtureDriver(fixture: state, presenter: shell.transcript)
        TranscriptDiagnostics.driver = driver
        TranscriptDiagnostics.counters = driver.counters
        let destination: PanelDestination = state == TranscriptFixtureState.ask ? PanelDestination.transcriptAsk
            : (state == TranscriptFixtureState.minutes ? PanelDestination.transcriptMinutes : PanelDestination.none)
        shell.panels.present(MeetingPanel.transcript, from: PanelInvoker.call, destination: destination)
        return driver
    }

    static func fixtureState(named raw: String?) -> TranscriptFixtureState? {
        guard let raw = raw else { return nil }
        return TranscriptFixtureState(rawValue: raw.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines))
    }

    func readout() -> String {
        "calls " + presenter.callsReadout() + "; rebuilds " + String(presenter.feed.rebuildCount) + "; rows "
            + String(presenter.feed.rowIds.count) + "; export.bytes " + String(presenter.exportBytes) + "; stop "
            + presenter.snapshot.stop.rawValue + "; recap " + recap.rawValue
    }

    func run(_ script: TranscriptFixtureScriptName) {
        switch script {
        case .stream10:
            streamPartials(10, finalize: true)
        case .growFiveLines:
            growNewestByFiveLines()
        case .stopFails:
            stopFails = true
        case .askReject:
            askMode = "reject"
        case .askSilence:
            askMode = "silence"
        case .recapFails:
            recapFails = true
        case .resetCounters:
            counters.reset()
        }
    }

    func streamPartials(_ count: Int, finalize: Bool) {
        nextSegment += 1
        let id = "live-" + String(nextSegment)
        let start = (state.orderedSegments.last?.startMs ?? TranscriptFixtureScript.baseMillis) + 5_000.0
        var text = ""
        var index = 0
        while index < count {
            text = text.isEmpty ? "and then" : text + " we"
            state.applyPartial(TranscriptSegmentModel(itemId: id, sequence: nextSegment, speakerUserId: TranscriptFixtureScript.samId,
                                                      speakerDisplayName: TranscriptFixtureScript.name(TranscriptFixtureScript.samId),
                                                      text: text, startMs: start, isFinal: false))
            index += 1
        }
        if finalize {
            state.applyFinal(TranscriptSegmentModel(itemId: id, sequence: nextSegment, speakerUserId: TranscriptFixtureScript.samId,
                                                    speakerDisplayName: TranscriptFixtureScript.name(TranscriptFixtureScript.samId),
                                                    text: text + " ship it.", startMs: start, isFinal: true))
        }
    }

    func growNewestByFiveLines() {
        nextSegment += 1
        let start = (state.orderedSegments.last?.startMs ?? TranscriptFixtureScript.baseMillis) + 4_000.0
        let long = "We should line up the review, the numbers, the date, the deck, the appendix, the owners and the follow ups "
            + "so that nothing slips between now and the launch and everyone knows who is doing what by when."
        state.applyPartial(TranscriptSegmentModel(itemId: "grow-" + String(nextSegment), sequence: nextSegment,
                                                  speakerUserId: TranscriptFixtureScript.averyId,
                                                  speakerDisplayName: TranscriptFixtureScript.name(TranscriptFixtureScript.averyId),
                                                  text: long + " " + long, startMs: start, isFinal: false))
    }

    func finishStop() {
        if state.sessionStatus == "stopping" { state.sessionStatus = "idle" }
    }

    func answer(questionId id: String, question: String) {
        state.applyQuestionUpdate(id: id, question: question, answer: "Two decisions so far:", status: TranscriptQAStatus.streaming,
                                  error: nil, timestamp: TranscriptFixtureScript.baseMillis)
        state.applyQuestionUpdate(id: id, question: question, answer: TranscriptFixtureScript.answer, status: TranscriptQAStatus.done,
                                  error: nil, timestamp: TranscriptFixtureScript.baseMillis)
    }

    func setRecap(_ next: RecapPhase) {
        recap = next
        applyInputs()
    }

    private func perform(_ command: TranscriptCommand) -> Bool {
        switch command.kind {
        case .start, .takeover:
            state.sessionStatus = "live"
            state.controllerUserId = TranscriptFixtureScript.localUserId
            state.controllerName = TranscriptFixtureScript.localName
            state.applyCapabilities(start: true, takeover: true, stop: true, ask: true)
        case .stop:
            if stopFails {
                stopFails = false
                state.setIssue(TranscriptIssue.controlsReconnecting)
                return true
            }
            state.sessionStatus = "stopping"
            if runsFollowUps {
                let delay = sleep
                Task { @MainActor [weak self] in
                    await delay(600.0)
                    self?.finishStop()
                }
            }
        case .pause:
            state.sessionStatus = "paused"
        case .resume:
            state.sessionStatus = "live"
        case .ask:
            nextQuestion += 1
            let id = "qa-fixture-" + String(nextQuestion)
            state.setIssue(TranscriptIssue.none)
            state.beginQuestion(id: id, question: command.text, timestamp: TranscriptFixtureScript.baseMillis)
            let mode = askMode
            askMode = "answer"
            if mode == "reject" {
                state.applyQuestionUpdate(id: id, question: command.text, answer: "", status: TranscriptQAStatus.error,
                                          error: "The assistant is busy. Try again in a moment.", timestamp: TranscriptFixtureScript.baseMillis)
            } else if mode == "answer" && runsFollowUps {
                let delay = sleep
                let question = command.text
                Task { @MainActor [weak self] in
                    await delay(400.0)
                    self?.answer(questionId: id, question: question)
                }
            }
        case .refreshMinutes:
            state.applyMinutesStatus(TranscriptMinutesStatus.generating)
            state.applyMinutes(TranscriptFixtureScript.minutes())
            state.applyMinutesStatus(TranscriptMinutesStatus.live)
        case .retryConnection:
            state.recordFailedAttempts(0)
            state.connectionStatus = TranscriptConnectionStatus.connected
            state.setIssue(TranscriptIssue.none)
        case .postRecap:
            let fails = recapFails
            recapFails = false
            setRecap(RecapPhase.posting)
            if runsFollowUps {
                let delay = sleep
                Task { @MainActor [weak self] in
                    await delay(800.0)
                    self?.setRecap(fails ? RecapPhase.failed : RecapPhase.posted)
                }
            }
        }
        return true
    }

    private func applyInputs() {
        let attendee = false
        presenter.apply(TranscriptInputs.make(callSession: 1, roomId: TranscriptFixtureScript.roomId,
                                              localUserId: TranscriptFixtureScript.localUserId, isAttendee: attendee,
                                              canPostToChat: true, recap: recap,
                                              joinedAtMillis: TranscriptFixtureScript.baseMillis))
    }

    private func seed() {
        state.connectionStatus = TranscriptConnectionStatus.connected
        state.applyProviderKeyAvailability(openAI: true, sarvam: true)
        switch fixture {
        case .idle:
            state.applyCapabilities(start: true, takeover: true, stop: true, ask: true)
            state.setRelay(RelayAvailability.available)
            state.markSessionSnapshot()
        case .viewOnly:
            state.applyCapabilities(start: false, takeover: false, stop: false, ask: false)
            state.setRelay(RelayAvailability.available)
            state.markSessionSnapshot()
        case .takeover:
            state.applyCapabilities(start: true, takeover: true, stop: true, ask: true)
            state.applyProviderKeyAvailability(openAI: false, sarvam: true)
            state.setRelay(RelayAvailability.available)
            state.markSessionSnapshot()
            state.sessionStatus = "takeover_needed"
        case .liveController, .ask, .minutes:
            seedLive(controller: TranscriptFixtureScript.localUserId, count: 24)
        case .liveFollower:
            state.applyCapabilities(start: false, takeover: false, stop: false, ask: true)
            seedLive(controller: TranscriptFixtureScript.averyId, count: 24)
        case .paused:
            seedLive(controller: TranscriptFixtureScript.localUserId, count: 24)
            state.sessionStatus = "paused"
        case .reconnecting:
            seedLive(controller: TranscriptFixtureScript.localUserId, count: 24)
            state.connectionStatus = TranscriptConnectionStatus.connecting
            state.recordFailedAttempts(3)
        case .unavailable:
            state.applyCapabilities(start: true, takeover: true, stop: true, ask: true)
            state.markSessionSnapshot()
            state.connectionStatus = TranscriptConnectionStatus.connecting
            state.recordFailedAttempts(TranscriptPhasePolicy.maxFailedAttempts)
        case .ended:
            seedLive(controller: TranscriptFixtureScript.localUserId, count: 24)
            state.sessionStatus = "idle"
            state.controllerUserId = ""
            state.controllerName = nil
        case .relayUnavailable:
            state.applyCapabilities(start: true, takeover: true, stop: true, ask: true)
            state.setRelay(RelayAvailability.unavailable)
            state.markSessionSnapshot()
        case .long:
            seedLive(controller: TranscriptFixtureScript.localUserId, count: 2_000)
        }
        if fixture == TranscriptFixtureState.minutes {
            state.applyMinutes(TranscriptFixtureScript.minutes())
            state.applyMinutesStatus(TranscriptMinutesStatus.live)
        }
        if fixture == TranscriptFixtureState.ask {
            state.beginQuestion(id: "qa-done", question: "What decisions have we made?", timestamp: TranscriptFixtureScript.baseMillis)
            state.applyQuestionUpdate(id: "qa-done", question: "What decisions have we made?", answer: TranscriptFixtureScript.answer,
                                      status: TranscriptQAStatus.done, error: nil, timestamp: TranscriptFixtureScript.baseMillis)
            state.beginQuestion(id: "qa-error", question: "Summarize the discussion", timestamp: TranscriptFixtureScript.baseMillis)
            state.applyQuestionUpdate(id: "qa-error", question: "Summarize the discussion", answer: "", status: TranscriptQAStatus.error,
                                      error: nil, timestamp: TranscriptFixtureScript.baseMillis)
            state.beginQuestion(id: "qa-unsent", question: "What are the action items?", timestamp: TranscriptFixtureScript.baseMillis)
            state.markQuestionNotSent(id: "qa-unsent")
            state.applyQuestionUpdate(id: "qa-unsent", question: "What are the action items?", answer: "", status: TranscriptQAStatus.error,
                                      error: "Question could not be sent.", timestamp: TranscriptFixtureScript.baseMillis)
        }
    }

    private func seedLive(controller: String, count: Int) {
        if !state.capabilitiesKnown {
            state.applyCapabilities(start: true, takeover: true, stop: true, ask: true)
        }
        state.setRelay(RelayAvailability.available)
        state.markSessionSnapshot()
        state.sessionStatus = "live"
        state.controllerUserId = controller
        state.controllerName = TranscriptFixtureScript.name(controller)
        state.applySessionStartedAt(TranscriptFixtureScript.baseMillis)
        let finals = TranscriptFixtureScript.finals(count: count)
        var partials: [TranscriptSegmentModel] = []
        if let last = finals.last {
            partials.append(TranscriptFixtureScript.segment(count + 1, userId: TranscriptFixtureScript.samId, startMs: last.startMs + 6_000.0,
                                                           final: false, text: "And then we probably need to dec"))
        }
        state.replaceSnapshot(finals: finals, partials: partials)
    }
}
