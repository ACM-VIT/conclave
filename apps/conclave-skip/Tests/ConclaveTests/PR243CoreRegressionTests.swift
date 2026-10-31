#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct PR243CoreRegressionTests {
    @Test func prejoinRoutesAreConsumedBeforeSynchronousBackendPublish() {
        let owner = AudioRouteOwner()
        let output = AudioRouteOption(id: "speaker", kind: .speaker, name: "Speaker", isConnecting: false)
        let input = AudioRouteOption(id: "mic", kind: .receiver, name: "Microphone", isConnecting: false)
        var platform = AudioRoutePlatformState.make(options: [output], currentId: "receiver", inputs: [input], canChooseInput: true)
        var outputs: [String] = []
        var inputs: [String] = []
        owner.backend = AudioRouteBackend(applyOutput: { id in
            outputs.append(id)
            platform = AudioRoutePlatformState.make(options: [output], currentId: id, inputs: [input], canChooseInput: true)
            if outputs.count < 3 { owner.publish(platform) }
            return true
        }, adoptOutput: { _ in }, applyInput: { id in
            inputs.append(id)
            if inputs.count < 3 { owner.publish(platform) }
            return true
        }, requestBluetoothAccess: {}, refresh: {})
        owner.publish(platform)
        owner.setPrejoinIntent(outputKind: "speaker", inputId: "mic")
        owner.callAudioDidStart()
        owner.publish(platform)
        #expect(outputs == ["speaker"])
        #expect(inputs == ["mic"])
        #expect(owner.preferredInputIntent == "mic")
    }

    @Test func synchronousInputCallbackCanInstallANewerIntent() {
        let owner = AudioRouteOwner()
        let inputs = [AudioRouteOption(id: "one", kind: .receiver, name: "One", isConnecting: false),
                      AudioRouteOption(id: "two", kind: .receiver, name: "Two", isConnecting: false)]
        let platform = AudioRoutePlatformState.make(inputs: inputs, canChooseInput: true)
        var applied: [String] = []
        owner.backend = AudioRouteBackend(applyOutput: { _ in true }, adoptOutput: { _ in }, applyInput: { id in
            applied.append(id)
            if id == "one" && applied.count == 1 { owner.setPrejoinIntent(outputKind: "", inputId: "two") }
            owner.publish(platform)
            return true
        }, requestBluetoothAccess: {}, refresh: {})
        owner.publish(platform)
        owner.setPrejoinIntent(outputKind: "", inputId: "one")
        owner.callAudioDidStart()
        #expect(applied == ["one", "two"])
        #expect(owner.preferredInputIntent == "two")
    }

    @Test func systemUnmuteDoesNotDispatchWhileTheAudioOwnerBlocksIt() {
        let presence = CallPresence()
        var commands: [SystemCallCommand] = []
        presence.onCommand = { commands.append($0) }
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .entering, isMuted: true))
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall, isMuted: true))
        let session = presence.snapshot.presenceSession
        for interruption in [AudioInterruptionKind.held, .otherAudio, .servicesReset, .deviceMicMuted] {
            presence.reportInterruption(interruption)
            #expect(presence.handle(.unmute, source: .notification, presenceSession: session) == .unavailable)
        }
        #expect(commands.isEmpty)
        presence.reportInterruption(.none)
        #expect(presence.handle(.unmute, source: .notification, presenceSession: session) == .dispatched)
        #expect(commands.count == 1)
    }

    @Test func assistantRetryUsesANewIdentityAndCannotInheritPeerFailure() throws {
        let asker = ConclaveAssistantStore()
        let peer = ConclaveAssistantStore()
        asker.schedulesTimers = false
        peer.schedulesTimers = false
        asker.begin(answerId: "old", question: "Question", questionMessageId: "question")
        asker.fail(answerId: "old", kind: .generic)
        peer.applyRelay(answerId: "old", reasoning: "A long failed attempt", reasoningDone: true, tasks: [], done: false, errored: true)
        let next = try #require(asker.beginRetry(answerId: "old"))
        #expect(next.answerId != "old" && next.questionMessageId == "question" && next.question == "Question")
        #expect(!asker.hasAnswer("old") && asker.beginRetry(answerId: "old") == nil)
        peer.applyRelay(answerId: next.answerId, reasoning: "OK", reasoningDone: true, tasks: [], done: true, errored: false)
        peer.applyRelay(answerId: "old", reasoning: "Late failure", reasoningDone: true, tasks: [], done: false, errored: true)
        #expect(peer.input(forMessageId: next.answerId)?.reasoning == "OK")
        #expect(peer.input(forMessageId: next.answerId)?.errorKind == AssistantErrorKind.none)
        #expect(peer.input(forMessageId: next.answerId)?.isDone == true)
        #expect(peer.content(forMessageId: next.answerId, messageContent: "Short success") == "Short success")
        #expect(peer.input(forMessageId: "old")?.errorKind == .generic)
    }

    @Test func recapRequiresTheExactAnswerAndRejectsPreviousRequests() {
        let recap = RecapCoordinator()
        recap.now = { 1000 }
        recap.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        var requested: [String] = []
        var ends = 0
        recap.sendRecap = { requested.append($0); return true }
        recap.endCall = { ends += 1 }
        #expect(recap.postAndEnd())
        let first = recap.requestedAnswerId
        recap.noteAssistantAnswerSettled(answerId: "unrelated", atMillis: 2000, failed: false)
        #expect(ends == 0 && recap.isPostingBeforeEnd)
        recap.reset()
        #expect(recap.postAndEnd())
        let second = recap.requestedAnswerId
        #expect(first != second && requested == [first, second])
        recap.noteAssistantAnswerSettled(answerId: first, atMillis: 2000, failed: true)
        #expect(ends == 0)
        recap.noteAssistantAnswerSettled(answerId: second, atMillis: 2000, failed: false)
        recap.noteAssistantAnswerSettled(answerId: second, atMillis: 2001, failed: false)
        #expect(ends == 1 && recap.endCount == 1 && !recap.hasCapTimer)
        recap.reset()
    }

    @Test func recapIdentityExistsBeforeASynchronousAnswerCompletes() {
        let recap = RecapCoordinator()
        var ends = 0
        recap.endCall = { ends += 1 }
        recap.sendRecap = { id in
            recap.noteAssistantAnswerSettled(answerId: id, atMillis: recap.requestedAtMillis, failed: false)
            return true
        }
        #expect(recap.postAndEnd())
        #expect(ends == 1 && recap.phase == .posted && !recap.hasCapTimer)
        #expect(recap.requestedAnswerId.isEmpty)
    }
}

@MainActor
struct PR243AppMountRegressionTests {
    private final class Wire {
        var delivered: [String] = []
        var events: [ActiveAppEvent] = []
        var continuations: [CheckedContinuation<AppsSyncResponse, Error>] = []
    }

    private func session(_ wire: Wire) -> ActiveAppSession {
        let session = ActiveAppSession()
        session.bundleOrigin = AppBridgeProtocol.iosOrigin
        session.sleep = { _ in }
        session.syncTransport = { _, _ in
            try await withCheckedThrowingContinuation { wire.continuations.append($0) }
        }
        session.onEvent = { wire.events.append($0) }
        session.begin(appId: "whiteboard", callSessionId: "call-pr243", isReadOnly: false)
        session.attachBridge(appSessionId: session.appSessionId) { wire.delivered.append($0) }
        return session
    }

    private func ready(_ session: ActiveAppSession, mount: Int) -> AppBridgeRejection {
        let raw = "{\"v\":1,\"type\":\"ready\",\"callSessionId\":\"\(session.callSessionId)\",\"appSessionId\":\"\(session.appSessionId)\",\"requestId\":\"e-1\",\"payload\":{\"appId\":\"whiteboard\",\"bundleVersion\":\"1.0.0\",\"stateVector\":\"AA==\"}}"
        return session.receiveFromEmbed(raw: raw, origin: AppBridgeProtocol.iosOrigin, isMainFrame: true, mount: mount)
    }

    private func settle(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<300 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return condition()
    }

    @Test func reloadAcceptsItsOwnE1ButRejectsOldMountAndOldSync() async {
        let wire = Wire()
        let relay = session(wire)
        let old = relay.bridgeGeneration
        #expect(ready(relay, mount: old) == .none)
        #expect(await settle { wire.continuations.count == 1 })
        #expect(relay.lifecycle == .opening && !wire.events.contains { $0.kind == .ready })
        relay.attachBridge(appSessionId: relay.appSessionId) { wire.delivered.append($0) }
        let current = relay.bridgeGeneration
        #expect(current != old)
        #expect(ready(relay, mount: old) == .notAttached)
        #expect(ready(relay, mount: current) == .none)
        #expect(ready(relay, mount: current) == .duplicateRequest)
        #expect(await settle { wire.continuations.count == 2 })
        relay.detachBridge(appSessionId: relay.appSessionId, mount: old)
        relay.embedFailed(appSessionId: relay.appSessionId, issue: .rendererGone, mount: old)
        #expect(relay.lifecycle == .opening && relay.embedReady)
        let response = AppsSyncResponse(syncMessage: Data([1]), stateVector: nil, awarenessUpdate: nil)
        if wire.continuations.count == 2 {
            wire.continuations[0].resume(returning: response)
            await Task.yield()
            #expect(!wire.delivered.contains { AppBridgeCodec.jsonObject($0)?["type"] as? String == "snapshot" })
            wire.continuations[1].resume(returning: response)
        }
        #expect(await settle { relay.lifecycle == .ready })
        #expect(wire.events.filter { $0.kind == .ready }.count == 1)
        #expect(wire.delivered.filter { AppBridgeCodec.jsonObject($0)?["type"] as? String == "snapshot" }.count == 1)
        relay.end()
    }

    @Test func twoSyncFailuresFailTheHostWithoutAdvertisingReady() async {
        let wire = Wire()
        let relay = session(wire)
        let presenter = AppHostPresenter()
        presenter.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        presenter.bind(session: relay)
        presenter.apply(AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: true))
        relay.attachBridge(appSessionId: relay.appSessionId) { wire.delivered.append($0) }
        var attempts = 0
        relay.syncTransport = { _, _ in attempts += 1; throw NSError(domain: "PR243", code: 1) }
        #expect(ready(relay, mount: relay.bridgeGeneration) == .none)
        #expect(presenter.model.phase == .opening && presenter.hasReadyTimer)
        #expect(await settle { relay.lifecycle == .failed })
        #expect(attempts == 2 && presenter.model.phase == .failed)
        #expect(presenter.model.issue == .loadFailed && !presenter.model.wantsWebView)
        #expect(!wire.delivered.contains { AppBridgeCodec.jsonObject($0)?["type"] as? String == "snapshot" })
        relay.end()
    }

    @Test func replacingMountDuringRetryBackoffPreventsAnotherTransportRequest() async {
        let wire = Wire()
        let relay = session(wire)
        var attempts = 0
        var backoff: CheckedContinuation<Void, Never>?
        relay.sleep = { _ in await withCheckedContinuation { backoff = $0 } }
        relay.syncTransport = { _, _ in
            attempts += 1
            throw NSError(domain: "PR243", code: 1)
        }
        #expect(ready(relay, mount: relay.bridgeGeneration) == .none)
        #expect(await settle { backoff != nil })
        relay.attachBridge(appSessionId: relay.appSessionId) { wire.delivered.append($0) }
        backoff?.resume()
        for _ in 0..<20 { await Task.yield() }
        #expect(attempts == 1)
        #expect(relay.lifecycle != .failed)
        relay.end()
    }

    @Test func aRetriedEmptySnapshotIsStillAValidReadyRoom() async {
        let wire = Wire()
        let relay = session(wire)
        var attempts = 0
        relay.syncTransport = { _, _ in
            attempts += 1
            if attempts == 1 { throw NSError(domain: "PR243", code: 1) }
            return AppsSyncResponse(syncMessage: Data(), stateVector: nil, awarenessUpdate: nil)
        }
        #expect(ready(relay, mount: relay.bridgeGeneration) == .none)
        #expect(await settle { relay.lifecycle == .ready })
        #expect(attempts == 2 && wire.events.filter { $0.kind == .ready }.count == 1)
        relay.end()
    }
}
#endif
