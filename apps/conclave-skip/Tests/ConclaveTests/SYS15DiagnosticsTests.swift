#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SYS-15 (OUT/PLAN-screens.md section 5; S70 15, 0.6 SX7, 0.7 SY16, R70-4, O8): the 200-event code-only ring, the
/// structural redaction policy, spans and milestones over a recording platform seam, the presence adapter across 20 join
/// and leave cycles (AC-SI18-2), the 7 days or 2 MB store, the always-written export (15 f), the redaction test (15 l4),
/// the forced redaction failure (15 l5), the export presenter, and source scans of the iOS and Android platform parts
/// (S70 O14: no iOS-hosted test bundle). Not run in the heads-down push.
@MainActor
struct SYS15DiagnosticsTests {
    // MARK: Helpers

    /// The recording seam (S70 15 l2): every platform call is counted; the clocks are scripted.
    @MainActor
    final class RecordingHooks {
        var now = 1_000.0
        var wall = 1_761_661_353_000.0
        var begins: [String] = []
        var ends: [String] = []
        var events: [String] = []
        var logs: [String] = []
        var processStates: [String] = []
        var installs = 0

        func make() -> DiagnosticsPlatformHooks {
            let hooks = DiagnosticsPlatformHooks()
            hooks.beginInterval = { [unowned self] name, _, _ in self.begins.append(name) }
            hooks.endInterval = { [unowned self] name, _, _ in self.ends.append(name) }
            hooks.emitEvent = { [unowned self] name, _ in self.events.append(name) }
            hooks.log = { [unowned self] category, code, phase in self.logs.append("\(category) \(code) \(phase)") }
            hooks.processState = { [unowned self] session, phase in self.processStates.append("\(session):\(phase)") }
            hooks.installListeners = { [unowned self] _ in self.installs += 1 }
            hooks.counters = { [DiagnosticsCounter(key: "frame.slow", value: 2.0)] }
            hooks.info = {
                DiagnosticsPlatformInfo(platform: "test", appVersion: "2.0.0 (50)", osVersion: "Test 1.0", deviceClass: "phone")
            }
            hooks.monotonicMillis = { [unowned self] in self.now }
            hooks.wallMillis = { [unowned self] in self.wall }
            return hooks
        }
    }

    private func temporaryStore() -> DiagnosticsFileStore {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("sys15-" + UUID().uuidString, isDirectory: true)
        return DiagnosticsFileStore(directoryPath: base.appendingPathComponent("store").path,
                                    exportDirectoryPath: base.appendingPathComponent("exports").path)
    }

    private func exportFiles(_ store: DiagnosticsFileStore) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: store.exportDirectoryPath)) ?? [])
            .filter { $0.hasPrefix(DiagnosticsFileStore.exportPrefix) }
    }

    static func snapshot(phase: CallPresencePhase, callSession: Int = 1, isMuted: Bool = true, isInPip: Bool = false,
                         interruption: AudioInterruptionKind = .none, surfaceStatus: CallSurfaceStatus = .inactive,
                         endReason: CallEndReason = .none, revision: Int = 1) -> CallPresenceSnapshot {
        CallPresenceSnapshot(
            revision: revision, presenceSession: callSession, callSession: callSession, phase: phase,
            title: "lily-zoro-iris", roomId: "lily-zoro-iris", joinedAtMillis: 1_000, isMuted: isMuted, isCameraOn: false,
            isPresenting: false, isAttendee: false, surface: .none, surfaceStatus: surfaceStatus, interruption: interruption,
            pip: .eligible, isInPictureInPicture: isInPip, pipTarget: nil, keepsScreenAwake: true, proximityArmed: false,
            cameraContinuesInBackground: false, endReason: endReason
        )
    }

    private func breadcrumb(_ code: String, phase: String = "live", kind: DiagnosticsEventKind = .event) -> DiagnosticsBreadcrumb {
        DiagnosticsBreadcrumb(code: code, phase: phase, kind: kind.rawValue, atMillis: 1, attempt: 1, durationMillis: -1,
                              detail: "")
    }

    // MARK: S70 15 c: the ring

    @Test func theRingKeepsTheNewest200InOrder() {
        let ring = DiagnosticsBreadcrumbRing(capacity: DiagnosticsLimits.breadcrumbCapacity)
        for index in 0..<250 {
            ring.append(breadcrumb("test.event\(index)"))
        }
        let items = ring.snapshot()
        #expect(DiagnosticsLimits.breadcrumbCapacity == 200)
        #expect(ring.count == 200 && items.count == 200)
        #expect(items.first?.code == "test.event50" && items.last?.code == "test.event249")
        #expect(ring.droppedCount == 50)
        let small = DiagnosticsBreadcrumbRing(capacity: 3)
        small.append(breadcrumb("test.a"))
        small.append(breadcrumb("test.b"))
        #expect(small.snapshot().map { $0.code } == ["test.a", "test.b"])
    }

    // MARK: S70 15 j: structural redaction

    @Test func codesPhasesAndDetailsComeFromFixedVocabularies() {
        for code in ["socket.timeout", "http.503", "message.timedOut", "phase.live", "call.end.userLeft", "android.offline",
                     "capture.appGroup", "url.unreachable", "task.cancelled", "media.noCamera", "span.join", "join.tokenFetched"] {
            #expect(DiagnosticsRedactionPolicy.isAllowedCode(code), "\(code)")
        }
        for code in ["", "socket", "lily-zoro-iris", "message.lily-zoro-iris", "https://conclave.acmvit.in/lily-zoro-iris",
                     "message.Hello there", "chat.hello", "message..empty", "message.", ".timedOut", "name.Zelda",
                     "message." + String(repeating: "a", count: 80)] {
            #expect(!DiagnosticsRedactionPolicy.isAllowedCode(code), "\(code)")
            #expect(DiagnosticsRedactionPolicy.sanitizedCode(code) == DiagnosticsRedactionPolicy.rejectedCode)
        }
        for phase in CallPresencePhase.allCases {
            #expect(DiagnosticsRedactionPolicy.sanitizedPhase(phase.rawValue) == phase.rawValue)
        }
        #expect(DiagnosticsRedactionPolicy.sanitizedPhase("launch") == "launch")
        #expect(DiagnosticsRedactionPolicy.sanitizedPhase("Zelda") == "other")
        for context in MeetingErrorContext.allCases {
            #expect(DiagnosticsRedactionPolicy.isAllowedDetail(context.rawValue))
        }
        #expect(DiagnosticsRedactionPolicy.isAllowedDetail("join.failed"))
        #expect(!DiagnosticsRedactionPolicy.isAllowedDetail("Zelda Quartermaine"))
        #expect(DiagnosticsRedactionPolicy.isAllowedFieldText("iPhone OS 17.5 (21F79)"))
        #expect(!DiagnosticsRedactionPolicy.isAllowedFieldText("Zelda's room?"))
        #expect(!DiagnosticsRedactionPolicy.isAllowedFieldText(String(repeating: "a", count: 65)))
        #expect(DiagnosticsRedactionPolicy.category(forCode: "audio.muted") == .audio)
        #expect(DiagnosticsRedactionPolicy.category(forCode: "pip.start") == .pip)
        #expect(DiagnosticsRedactionPolicy.category(forCode: "rejoin.failed") == .recovery)
        #expect(DiagnosticsRedactionPolicy.category(forCode: "links.open") == .links)
        #expect(DiagnosticsRedactionPolicy.category(forCode: "capture.socket") == .share)
        #expect(DiagnosticsRedactionPolicy.category(forCode: "socket.timeout") == .call)
    }

    @Test func everyClassifierCodeIsAllowed() throws {
        // Every literal code the S70 7 classifier can produce passes, so a classified failure is never rejected.
        let source = try sys15Source("Sources/Conclave/Core/Session/MeetingErrorClassifier.swift")
        var codes: [String] = []
        for marker in ["code: \"", "diagnosticCode: \""] {
            var rest = source[...]
            while let range = rest.range(of: marker) {
                let tail = rest[range.upperBound...]
                guard let close = tail.firstIndex(of: "\"") else { break }
                codes.append(String(tail[..<close]))
                rest = tail[close...]
            }
        }
        #expect(codes.count > 20)
        for code in codes where !code.hasSuffix(".") {
            #expect(DiagnosticsRedactionPolicy.isAllowedCode(code), "\(code)")
        }
        // The two prefixes completed at run time.
        #expect(DiagnosticsRedactionPolicy.isAllowedCode("http.503"))
        #expect(DiagnosticsRedactionPolicy.isAllowedCode("android.serverUnreachable"))
        let classified = MeetingErrorClassifier.classify(serverMessage: "Request timed out", context: .join)
        #expect(DiagnosticsRedactionPolicy.isAllowedCode(classified.diagnosticCode))
    }

    @Test func recordStoresCodesOnlyAndRejectsFreeText() {
        let recording = RecordingHooks()
        let diagnostics = CallDiagnostics(store: temporaryStore(), hooks: recording.make())
        diagnostics.record(code: "Zelda Quartermaine joined lily-zoro-iris")
        diagnostics.record(code: "socket.timeout", phase: "Zelda")
        let failure = ClassifiedError(category: .rejectedByServer, context: .chat, serverText: "PINEAPPLE-MARKER-7",
                                      diagnosticCode: "message.unrecognized", retryAfterSeconds: 0)
        diagnostics.recordFailure(failure)
        let events = diagnostics.events
        #expect(events.map { $0.code } == [DiagnosticsRedactionPolicy.rejectedCode, "socket.timeout", "message.unrecognized"])
        #expect(events[1].phase == "other")
        #expect(events[2].detail == "chat")
        #expect(diagnostics.rejectedCount == 1)
        #expect(!events.contains { $0.code.contains("PINEAPPLE") || $0.detail.contains("PINEAPPLE") })
        // Logs carry the category, the code and the phase only.
        #expect(recording.logs == ["call diag.rejectedCode launch", "call socket.timeout other", "call message.unrecognized launch"])
    }

    // MARK: S70 15 c, j: spans and milestones

    @Test func spansBalanceEndOnceAndRejectUnknownNames() {
        let recording = RecordingHooks()
        let diagnostics = CallDiagnostics(store: temporaryStore(), hooks: recording.make())
        let mute = diagnostics.span(DiagnosticsSpanKind.mute.rawValue, callSession: 4)
        #expect(!mute.isInert && mute.callSession == 4)
        // One span per kind and session.
        #expect(diagnostics.span(DiagnosticsSpanKind.mute.rawValue, callSession: 4) == mute)
        recording.now += 180
        #expect(diagnostics.end(mute) == 180)
        #expect(diagnostics.end(mute) == -1, "ending twice does nothing")
        let unknown = diagnostics.span("Zelda", callSession: 4)
        #expect(unknown.isInert && diagnostics.end(unknown) == -1)
        #expect(recording.begins == ["mute"] && recording.ends == ["mute"])
        #expect(diagnostics.spanBeginCount == diagnostics.spanEndCount && diagnostics.openSpanCount == 0)
        let last = diagnostics.events.last
        #expect(last?.code == "span.mute" && last?.kind == DiagnosticsEventKind.spanEnd.rawValue && last?.durationMillis == 180)
        // The open-span bound drops (and closes) the oldest.
        for session in 0..<(DiagnosticsLimits.maxOpenSpans + 3) {
            diagnostics.span(DiagnosticsSpanKind.route.rawValue, callSession: session)
        }
        #expect(diagnostics.openSpanCount == DiagnosticsLimits.maxOpenSpans)
        #expect(recording.begins.count - recording.ends.count == DiagnosticsLimits.maxOpenSpans)
        #expect(diagnostics.events.contains { $0.code == "diag.spanDropped" })
    }

    @Test func milestonesCarryTheTimeSinceTheJoinSpan() {
        let recording = RecordingHooks()
        let diagnostics = CallDiagnostics(store: temporaryStore(), hooks: recording.make())
        diagnostics.presenceDidChange(from: Self.snapshot(phase: .idle, callSession: 0), to: Self.snapshot(phase: .connecting, callSession: 7))
        recording.now += 250
        diagnostics.milestone(DiagnosticsMilestone.tokenFetched.rawValue)
        diagnostics.milestone(DiagnosticsMilestone.firstDisplayedFrame.rawValue, callSession: 7, atMillis: recording.now + 900)
        diagnostics.milestone("lily-zoro-iris")
        let milestones = diagnostics.events.filter { $0.kind == DiagnosticsEventKind.milestone.rawValue }
        #expect(milestones.map { $0.code } == ["join.tokenFetched", "join.firstDisplayedFrame"])
        #expect(milestones.map { $0.durationMillis } == [250, 1_150])
        #expect(milestones.allSatisfy { $0.attempt == 7 })
        #expect(recording.events == ["tokenFetched", "firstDisplayedFrame"])
        #expect(diagnostics.rejectedCount == 1)
    }

    @Test func viewModelTimingsBecomeJoinMilestones() {
        #expect(DiagnosticsTimingBridge.milestone(forTiming: "join_fetch_info") == .tokenFetched)
        #expect(DiagnosticsTimingBridge.milestone(forTiming: "join_socket_connect") == .socketConnected)
        #expect(DiagnosticsTimingBridge.milestone(forTiming: "join_webrtc_configure") == .transportConfigured)
        #expect(DiagnosticsTimingBridge.milestone(forTiming: "join_start_producing") == .producerCreated)
        #expect(DiagnosticsTimingBridge.milestone(forTiming: "join_socket_join_room") == .joinedResponse)
        #expect(DiagnosticsTimingBridge.milestone(forTiming: "meeting_sheet_open") == nil)
    }

    // MARK: S70 0.5 presence: phase spans

    @Test func presenceDrivesJoinRecoveryPipAndCleanupSpans() {
        let recording = RecordingHooks()
        let diagnostics = CallDiagnostics(store: temporaryStore(), hooks: recording.make())
        var old = Self.snapshot(phase: .idle, callSession: 0)
        func move(_ next: CallPresenceSnapshot) {
            diagnostics.presenceDidChange(from: old, to: next)
            old = next
        }
        move(Self.snapshot(phase: .connecting, callSession: 3))
        recording.now += 1_200
        move(Self.snapshot(phase: .live, callSession: 3))
        move(Self.snapshot(phase: .live, callSession: 3, isMuted: false))
        move(Self.snapshot(phase: .live, callSession: 3, isMuted: false, isInPip: true))
        recording.now += 400
        move(Self.snapshot(phase: .live, callSession: 3, isMuted: false, isInPip: false))
        move(Self.snapshot(phase: .recovering, callSession: 3, interruption: .otherAudio))
        recording.now += 2_000
        move(Self.snapshot(phase: .live, callSession: 3, surfaceStatus: .refused))
        move(Self.snapshot(phase: .ending, callSession: 3))
        move(Self.snapshot(phase: .idle, callSession: 0, endReason: .userLeft))
        let ends = diagnostics.events.filter { $0.kind == DiagnosticsEventKind.spanEnd.rawValue }
        #expect(ends.map { $0.code } == ["span.join", "span.pip", "span.recovery", "span.cleanup"])
        #expect(ends.map { $0.durationMillis } == [1_200, 400, 2_000, 0])
        #expect(ends.allSatisfy { $0.attempt == 3 })
        let codes = diagnostics.events.map { $0.code }
        for code in ["phase.connecting", "phase.live", "audio.unmuted", "audio.interruption.otherAudio", "phase.recovering",
                     "call.surface.refused", "phase.ending", "phase.idle", "call.end.userLeft"] {
            #expect(codes.contains(code), "\(code)")
        }
        #expect(recording.processStates.first == "3:connecting" && recording.processStates.last == "3:idle")
        #expect(diagnostics.openSpanCount == 0 && recording.begins.count == recording.ends.count)
        #expect(diagnostics.currentAttempt == 3 && diagnostics.currentPhase == "idle")
    }

    @Test func aJoinThatNeverGoesLiveEndsAsFailedAndTheWaitingRoomEndsTheSpan() {
        let recording = RecordingHooks()
        let diagnostics = CallDiagnostics(store: temporaryStore(), hooks: recording.make())
        diagnostics.presenceDidChange(from: Self.snapshot(phase: .idle, callSession: 0), to: Self.snapshot(phase: .connecting, callSession: 5))
        diagnostics.presenceDidChange(from: Self.snapshot(phase: .connecting, callSession: 5), to: Self.snapshot(phase: .idle, callSession: 0))
        diagnostics.presenceDidChange(from: Self.snapshot(phase: .idle, callSession: 0), to: Self.snapshot(phase: .connecting, callSession: 6))
        diagnostics.presenceDidChange(from: Self.snapshot(phase: .connecting, callSession: 6), to: Self.snapshot(phase: .waiting, callSession: 6))
        let ends = diagnostics.events.filter { $0.kind == DiagnosticsEventKind.spanEnd.rawValue }
        #expect(ends.map { $0.detail } == ["join.failed", "join.waiting"])
        #expect(ends.map { $0.attempt } == [5, 6])
        #expect(diagnostics.openSpanCount == 0)
    }

    /// AC-SI18-2 (S70 15 l2): 20 fixture join and leave cycles leave one listener set and a bounded buffer.
    @Test func twentyJoinAndLeaveCyclesKeepOneListenerSetAndABoundedBuffer() {
        let recording = RecordingHooks()
        let diagnostics = CallDiagnostics(store: temporaryStore(), hooks: recording.make())
        diagnostics.install()
        diagnostics.install()
        let adapter = diagnostics.makePresenceAdapter()
        var old = Self.snapshot(phase: .idle, callSession: 0)
        for cycle in 1...20 {
            let steps = [
                Self.snapshot(phase: .connecting, callSession: cycle),
                Self.snapshot(phase: .live, callSession: cycle),
                Self.snapshot(phase: .live, callSession: cycle, isMuted: false),
                Self.snapshot(phase: .live, callSession: cycle, isMuted: false, isInPip: true),
                Self.snapshot(phase: .recovering, callSession: cycle, isMuted: false, isInPip: true),
                Self.snapshot(phase: .live, callSession: cycle, isMuted: false),
                Self.snapshot(phase: .ending, callSession: cycle),
                Self.snapshot(phase: .idle, callSession: 0, endReason: .userLeft),
            ]
            for next in steps {
                adapter.presenceDidChange(old, next)
                old = next
            }
            let mute = diagnostics.span(DiagnosticsSpanKind.mute.rawValue)
            diagnostics.end(mute)
        }
        #expect(diagnostics.listenerCount == 1 && recording.installs == 1 && diagnostics.installCallCount == 2)
        #expect(diagnostics.readoutValue(DiagnosticsReadout.listenersKey) == "1")
        #expect(diagnostics.bufferCount <= DiagnosticsLimits.breadcrumbCapacity)
        #expect(Int(diagnostics.readoutValue(DiagnosticsReadout.bufferKey)) ?? 999 <= 200)
        #expect(diagnostics.openSpanCount == 0 && diagnostics.readoutValue(DiagnosticsReadout.openSpansKey) == "0")
        #expect(diagnostics.spanBeginCount == diagnostics.spanEndCount)
        #expect(recording.begins.count == recording.ends.count)
        #expect(diagnostics.presenceAdapterCount == 1)
    }

    // MARK: S70 15 c: the local store (7 days or 2 MB)

    @Test func retentionDropsOlderThanSevenDaysThenTheOldestOverTwoMegabytes() {
        let day = 24.0 * 60.0 * 60.0 * 1000.0
        let now = 100.0 * day
        let records = [
            DiagnosticsStoredRecord(name: "a", createdAtMillis: now - 8 * day, byteCount: 10),
            DiagnosticsStoredRecord(name: "b", createdAtMillis: now - 3 * day, byteCount: 900_000),
            DiagnosticsStoredRecord(name: "c", createdAtMillis: now - 2 * day, byteCount: 900_000),
            DiagnosticsStoredRecord(name: "d", createdAtMillis: now - 1 * day, byteCount: 900_000),
        ]
        #expect(DiagnosticsLimits.maxStoreBytes == 2_097_152)
        #expect(DiagnosticsLimits.retentionMillis == 7 * day)
        #expect(DiagnosticsRetentionPolicy.namesToDelete(records, nowMillis: now) == ["a", "b"])
        #expect(DiagnosticsRetentionPolicy.namesToDelete(Array(records.prefix(2)), nowMillis: now) == ["a"])
        // The breadcrumb files count toward the cap.
        #expect(DiagnosticsRetentionPolicy.namesToDelete(Array(records.suffix(2)), nowMillis: now, reservedBytes: 400_000) == ["c"])
        #expect(DiagnosticsRetentionPolicy.namesToDelete([], nowMillis: now).isEmpty)
    }

    @Test func theStoreAppliesRetentionWhenAPayloadArrives() {
        let store = temporaryStore()
        let now = DiagnosticsClock.wallMillis()
        let old = DiagnosticsPayloadFactory.payload(kind: .hang, createdAtMillis: now - DiagnosticsLimits.retentionMillis - 1_000,
                                                    fields: [DiagnosticsPayloadFactory.number("hangDurationMillis", 900)],
                                                    detailJSON: "")
        #expect(store.writePayload(old))
        #expect(store.loadPayloads().isEmpty, "a payload older than 7 days is dropped at once")
        let big = "{\"frames\": \"" + String(repeating: "a", count: 800_000) + "\"}"
        for offset in 0..<4 {
            let payload = DiagnosticsPayloadFactory.payload(kind: .crash, createdAtMillis: now - Double(4 - offset) * 1_000,
                                                            fields: [], detailJSON: big)
            #expect(store.writePayload(payload))
        }
        let kept = store.loadPayloads()
        #expect(kept.count == 2, "four 800 KB payloads keep the newest two under 2 MB")
        #expect(kept.reduce(0) { $0 + $1.byteCount } <= DiagnosticsLimits.maxStoreBytes)
        #expect(kept.map { $0.payload.createdAtMillis } == [now - 2_000, now - 1_000])
        // A structurally unclean payload is never stored.
        let unclean = DiagnosticsStoredPayload(kind: "chat", createdAtMillis: now, fields: [], detailJSON: "")
        #expect(!store.writePayload(unclean))
    }

    @Test func theRingFlushesOnBackgroundAndComesBackAsThePreviousProcess() async {
        let store = temporaryStore()
        let first = RecordingHooks()
        let diagnostics = CallDiagnostics(store: store, hooks: first.make())
        diagnostics.record(code: "socket.timeout")
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            diagnostics.applicationDidEnterBackground { continuation.resume() }
        }
        #expect(diagnostics.flushCount == 1)
        let previous = store.launchHousekeeping(nowMillis: first.wall + 1_000)
        #expect(previous?.events.map { $0.code } == ["socket.timeout", "lifecycle.background"])
        // The next launch adopts it; a launch with no newer ring keeps the same previous ring.
        let next = CallDiagnostics(store: store, hooks: RecordingHooks().make())
        next.adoptPrevious(previous)
        #expect(next.previousProcessEvents.count == 2)
        #expect(store.launchHousekeeping(nowMillis: first.wall + 2_000)?.events.count == 2)
        // Older than the retention window: deleted.
        #expect(store.launchHousekeeping(nowMillis: first.wall + DiagnosticsLimits.retentionMillis + 10_000) == nil)
        #expect(store.readBreadcrumbs(DiagnosticsFileStore.previousBreadcrumbsName) == nil)
    }

    // MARK: S70 15 f: the export

    @Test func theExportAlwaysWritesMetadataEvenWhenTheStoreIsEmpty() async throws {
        let store = temporaryStore()
        let recording = RecordingHooks()
        let diagnostics = CallDiagnostics(store: store, hooks: recording.make())
        let url = try await diagnostics.exportRedacted()
        #expect(url.lastPathComponent == "conclave-diagnostics-20251028-142233.json")
        let data = try Data(contentsOf: url)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["format"] as? String == "conclave-diagnostics")
        let metadata = try #require(object["metadata"] as? [String: Any])
        #expect(metadata["platform"] as? String == "test")
        #expect(metadata["appVersion"] as? String == "2.0.0 (50)")
        #expect(metadata["deviceClass"] as? String == "phone")
        #expect(metadata["exportedAt"] as? String == "2025-10-28T14:22:33Z")
        #expect(metadata["remoteUpload"] as? Bool == false)
        #expect(metadata["eventCapacity"] as? Int == 200)
        #expect((object["events"] as? [Any])?.isEmpty == true)
        #expect((object["payloads"] as? [Any])?.isEmpty == true)
        let counters = try #require(object["counters"] as? [String: Any])
        #expect(counters["sys.diagBuffer"] as? Int == 0)
        #expect(counters["frame.slow"] as? Int == 2)
        // The export itself is recorded afterwards, so the next file shows it.
        #expect(diagnostics.events.last?.code == "diag.exported")
        #expect(exportFiles(store).count == 1)
        // A second export keeps only the newest file.
        recording.wall += 61_000
        _ = try await diagnostics.exportRedacted()
        #expect(exportFiles(store) == ["conclave-diagnostics-20251028-142334.json"])
    }

    /// S70 15 l4: a fixture whose roster, chat and room code contain marker strings yields an export with none of them.
    @Test func markersFromTheRosterChatAndRoomCodeNeverReachTheExport() async throws {
        let store = temporaryStore()
        let recording = RecordingHooks()
        // Real wall time, so the payload below is inside the 7-day window when the store prunes on write.
        recording.wall = DiagnosticsClock.wallMillis()
        let diagnostics = CallDiagnostics(store: store, hooks: recording.make())
        let roster = ["Zelda Quartermaine", "Bartholomew Ng"]
        let chat = "PINEAPPLE-MARKER-7 see you at the standup"
        let roomCode = "lily-zoro-iris"
        diagnostics.sensitiveValues = { roster + [roomCode, "zq@example.com"] }
        // Every way free text could try to enter the ring.
        diagnostics.record(code: roomCode)
        diagnostics.record(code: "message." + roster[0])
        diagnostics.record(code: chat, phase: roster[1])
        diagnostics.span(roster[0])
        diagnostics.milestone(chat)
        diagnostics.recordFailure(ClassifiedError(category: .rejectedByServer, context: .chat, serverText: chat,
                                                  diagnosticCode: "message.unrecognized", retryAfterSeconds: 0))
        diagnostics.presenceDidChange(from: Self.snapshot(phase: .idle, callSession: 0), to: Self.snapshot(phase: .connecting, callSession: 2))
        // A platform detail blob that happens to contain a marker is withheld, not exported.
        let leaky = DiagnosticsPayloadFactory.payload(kind: .crash, createdAtMillis: recording.wall - 1_000,
                                                      fields: [DiagnosticsPayloadFactory.number("signal", 11)],
                                                      detailJSON: "{\"binaryName\": \"Zelda Quartermaine\"}")
        #expect(store.writePayload(leaky))
        let url = try await diagnostics.exportRedacted()
        let text = try String(contentsOf: url, encoding: .utf8).lowercased()
        for marker in roster + ["pineapple", roomCode, "zq@example.com", "standup"] {
            #expect(!text.contains(marker.lowercased()), "\(marker) leaked")
        }
        #expect(text.contains("\"diag.withheldpayloads\": 1"))
        #expect(text.contains("\"signal\": 11"))
        #expect(text.contains("message.unrecognized"))
    }

    /// S70 15 f, l5: a failed redaction check refuses the export and writes no file.
    @Test func aForcedRedactionFailureRefusesTheExportAndWritesNoFile() async {
        let store = temporaryStore()
        let diagnostics = CallDiagnostics(store: store, hooks: RecordingHooks().make())
        diagnostics.debugForcesRedactionFailure = true
        do {
            _ = try await diagnostics.exportRedacted()
            Issue.record("the export should have been refused")
        } catch let error as DiagnosticsExportError {
            #expect(error.failure == .redactionCheckFailed)
        } catch {
            Issue.record("unexpected error \(error)")
        }
        #expect(exportFiles(store).isEmpty)
        #expect(diagnostics.events.last?.code == "diag.exportRefused")
    }

    @Test func aStoreFileOutsideTheVocabularyFailsTheRedactionCheck() async throws {
        let store = temporaryStore()
        let diagnostics = CallDiagnostics(store: store, hooks: RecordingHooks().make())
        // Written around writePayload (an older format or a tampered file).
        let tampered = DiagnosticsStoredPayload(kind: "crash", createdAtMillis: DiagnosticsClock.wallMillis(),
                                                fields: [DiagnosticsField(key: "note", isNumber: false, number: 0,
                                                                          text: "Zelda's room? lily-zoro-iris!")],
                                                detailJSON: "")
        #expect(store.ensureDirectory(store.directoryPath))
        try JSONEncoder().encode(tampered).write(to: store.fileURL(DiagnosticsFileStore.payloadPrefix + "tampered.json"))
        await #expect(throws: DiagnosticsExportError(failure: .redactionCheckFailed)) {
            _ = try await diagnostics.exportRedacted()
        }
        #expect(exportFiles(store).isEmpty)
    }

    @Test func theDocumentBuilderIsDeterministicAndCodeOnly() {
        let input = DiagnosticsExportInput(
            info: DiagnosticsPlatformInfo(platform: "ios", appVersion: "2.0.0 (50)", osVersion: "iOS 17.5", deviceClass: "phone"),
            exportedAtMillis: 1_761_661_353_000, launchedAtMillis: 1_761_661_000_000, monotonicNowMillis: 5_000,
            events: [DiagnosticsBreadcrumb(code: "span.join", phase: "live", kind: "spanEnd", atMillis: 4_000, attempt: 3,
                                           durationMillis: 1_200, detail: "")],
            previousEvents: [], previousWrittenAtMillis: 0,
            openSpans: [DiagnosticsSpanToken(id: 9, kind: "pip", callSession: 3, startedAtMillis: 4_500)],
            counters: [DiagnosticsCounter(key: "sys.diagListeners", value: 1)], markers: [], forcesRedactionFailure: false
        )
        #expect(DiagnosticsExportBuilder.passesRedactionCheck(input, payloads: []))
        let document = DiagnosticsExportBuilder.document(input, payloads: [])
        #expect(document == DiagnosticsExportBuilder.document(input, payloads: []))
        #expect(document.contains("{ \"code\": \"span.join\", \"phase\": \"live\", \"kind\": \"spanEnd\", \"atMillis\": 4000, \"attempt\": 3, \"durationMillis\": 1200 }"))
        #expect(document.contains("{ \"name\": \"pip\", \"attempt\": 3, \"ageMillis\": 500 }"))
        #expect(document.contains("\"captureWindowStart\": \"2025-10-28T14:16:40Z\""))
        #expect(document.contains("\"previousEvents\": { \"writtenAt\": \"\", \"events\": [] }"))
        #expect(DiagnosticsJSON.number(12) == "12" && DiagnosticsJSON.number(Double.nan) == "0")
        #expect(DiagnosticsJSON.string("a\"b\\c\n") == "\"a\\\"b\\\\c\\n\"")
        #expect(DiagnosticsJSON.isRawJSON(" {\"a\": 1} ") && !DiagnosticsJSON.isRawJSON("hello"))
    }

    @Test func utcStampsNeedNoFormatter() {
        #expect(DiagnosticsTimePolicy.iso8601(epochMillis: 0) == "1970-01-01T00:00:00Z")
        #expect(DiagnosticsTimePolicy.iso8601(epochMillis: 1_761_661_353_000) == "2025-10-28T14:22:33Z")
        #expect(DiagnosticsTimePolicy.iso8601(epochMillis: 1_709_208_000_000) == "2024-02-29T12:00:00Z")
        #expect(DiagnosticsTimePolicy.iso8601(epochMillis: 951_825_600_000) == "2000-02-29T12:00:00Z")
        #expect(DiagnosticsTimePolicy.iso8601(epochMillis: -5) == "1970-01-01T00:00:00Z")
        #expect(DiagnosticsTimePolicy.fileStamp(epochMillis: 1_761_661_353_000) == "20251028-142233")
        #expect(DiagnosticsFileStore.exportName(epochMillis: 1_761_661_353_000) == "conclave-diagnostics-20251028-142233.json")
    }

    @Test func exitRecordsKeepOnlyAllowedFields() {
        let record = DiagnosticsPayloadFactory.exitRecord(reason: "anr", timestampMillis: 1_000, importance: 100, status: 0,
                                                          pssKb: 1_234, rssKb: 5_678, summarySession: 4, summaryPhase: "live",
                                                          traceJSON: "{\"traceLines\": [\"at a.b.C.d(C.kt:1)\"]}")
        #expect(record.kind == DiagnosticsPayloadKind.exitReason.rawValue)
        #expect(record.fields.contains { $0.key == "reason" && $0.text == "anr" })
        #expect(record.fields.contains { $0.key == "summaryPhase" && $0.text == "live" })
        #expect(record.fields.contains { $0.key == "summarySession" && $0.number == 4 })
        #expect(DiagnosticsRedactionPolicy.isClean(record))
        let odd = DiagnosticsPayloadFactory.exitRecord(reason: "Zelda's crash!", timestampMillis: 1_000, importance: 0, status: 0,
                                                       pssKb: 0, rssKb: 0, summarySession: 0, summaryPhase: "Zelda",
                                                       traceJSON: "not json")
        #expect(!odd.fields.contains { $0.key == "reason" || $0.key == "summaryPhase" })
        #expect(odd.detailJSON.isEmpty)
    }

    // MARK: The Settings row (R70-4)

    @Test func thePresenterSharesOnceAndShowsAFailureOnce() async {
        let store = temporaryStore()
        let diagnostics = CallDiagnostics(store: store, hooks: RecordingHooks().make())
        let presenter = DiagnosticsExportPresenter(diagnostics: diagnostics)
        #expect(presenter.phase == .idle)
        await presenter.exportAndWait()
        #expect(presenter.phase == .ready && presenter.readyRevision == 1)
        let path = presenter.takePendingShare()
        #expect(path.hasSuffix(".json") && FileManager.default.fileExists(atPath: path))
        #expect(presenter.takePendingShare().isEmpty, "a written file is shared once")
        presenter.shareFinished()
        #expect(presenter.phase == .idle)
        diagnostics.debugForcesRedactionFailure = true
        await presenter.exportAndWait()
        #expect(presenter.phase == .failed && presenter.failureRevision == 1)
        #expect(presenter.takePendingFailure() && !presenter.takePendingFailure(), "the failure shows once")
        #expect(presenter.takePendingShare().isEmpty)
        // One export at a time.
        diagnostics.debugForcesRedactionFailure = false
        presenter.export()
        await presenter.exportAndWait()
        #expect(presenter.exportCount == 3)
        presenter.shareFailed()
        #expect(presenter.phase == .failed && presenter.failureRevision == 2)
    }

    @Test func aboutOffersExportDiagnosticsInEveryScope() {
        #expect(DiagnosticsExportPolicy.isOffered)
        let capabilities = SettingsRowCapabilities.make(exportDiagnostics: DiagnosticsExportPolicy.isOffered)
        for scope in SettingsScope.allCases {
            for platform in SettingsPlatform.allCases {
                let sections = SettingsRowPolicy.sections(scope: scope, isAttendee: false, isHost: false, platform: platform,
                                                          capabilities: capabilities)
                let about = sections.first { $0.section == .about }?.rows ?? []
                #expect(about == [.privacy, .exportDiagnostics, .version], "\(scope) \(platform)")
            }
        }
        #expect(DiagnosticsReadout.listenersKey == "sys.diagListeners" && DiagnosticsReadout.bufferKey == "sys.diagBuffer")
    }

    // MARK: Source scans (S70 O14)

    @Test func theIOSPartsUseSignpostsLoggerCategoriesMetricKitAndTheBackgroundFlush() throws {
        let platform = try sys15Source("Sources/Conclave/Core/Diagnostics/CallDiagnostics+iOS.swift")
        #expect(platform.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(platform.contains("OSSignposter(subsystem: CallDiagnosticsIOS.subsystem, category: \"call\")"))
        #expect(platform.contains("signposter.makeSignpostID()"))
        for kind in DiagnosticsSpanKind.allCases {
            #expect(platform.contains("signposter.beginInterval(\"\(kind.rawValue)\", id: id)"), "\(kind)")
            #expect(platform.contains("signposter.endInterval(\"\(kind.rawValue)\", state)"), "\(kind)")
        }
        for milestone in DiagnosticsMilestone.allCases {
            #expect(platform.contains("signposter.emitEvent(\"\(milestone.rawValue)\", id: id)"), "\(milestone)")
        }
        for category in DiagnosticsLogCategory.allCases {
            #expect(platform.contains("Logger(subsystem: CallDiagnosticsIOS.subsystem, category: \"\(category.rawValue)\")"))
        }
        #expect(platform.contains("static let subsystem = \"com.acmvit.conclave\""))
        #expect(platform.contains("\"\\(code, privacy: .public) phase=\\(phase, privacy: .public)\""))
        #expect(platform.components(separatedBy: "privacy: .public").count == 3, "only the code and the phase are public")
        #expect(platform.contains("MXMetricManager.shared.add(subscriber)"))
        #expect(platform.contains("guard installed == nil else { return }"))
        for field in ["crashDiagnostics", "hangDiagnostics", "cpuExceptionDiagnostics", "diskWriteExceptionDiagnostics",
                      "appLaunchDiagnostics"] {
            #expect(platform.contains("payload.\(field)"), "\(field)")
        }
        // No free text from MetricKit: no exception message, arguments, region format or device type.
        for forbidden in [".composedMessage", ".arguments", ".regionFormat", ".deviceType", "jsonRepresentation() ?? payload",
                          "payload.jsonRepresentation()"] {
            #expect(!platform.contains(forbidden), "\(forbidden)")
        }
        #expect(platform.contains("UIApplication.didEnterBackgroundNotification"))
        #expect(platform.contains("beginBackgroundTask(withName: \"ConclaveDiagnosticsFlush\")"))
        #expect(platform.contains("CallDiagnostics.shared.applicationDidEnterBackground"))
    }

    @Test func theIOSRowIsAPlainButtonWithItsFooterAsTheHintAndAnInlineFailure() throws {
        let row = try sys15Source("Sources/Conclave/Core/Diagnostics/DiagnosticsExportRow+iOS.swift")
        #expect(row.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(row.contains("Button {") && !row.contains("NavigationLink") && !row.contains("chevron"))
        #expect(row.contains(".accessibilityHint(Text(DiagnosticsCopy.footer))"))
        #expect(row.contains("UIAccessibility.post(notification: .announcement, argument: DiagnosticsCopy.failure)"))
        #expect(row.contains("presenter.takePendingFailure()") && row.contains("presenter.takePendingShare()"))
        #expect(row.contains("Button(DiagnosticsCopy.tryAgain)"))
        #expect(row.contains("UIActivityViewController(activityItems: [item], applicationActivities: nil)"))
        #expect(row.contains("popover.sourceView = anchor"))
        #expect(row.contains("metadata.title = title"))
        for key in ["Export Diagnostics", "Creates a file without names, messages or meeting codes that you can send to support.",
                    "Conclave diagnostics", "Couldn\\u{2019}t create the diagnostics file.", "Try Again"] {
            #expect(row.contains("ConclaveStrings.text(\"\(key)\")"), "\(key)")
        }
        for forbidden in ["sensoryFeedback", "Haptic", "glassEffect", "StageEvent", "Color(", ".foregroundStyle(.red"] {
            #expect(!row.contains(forbidden), "\(forbidden)")
        }
    }

    @Test func theAndroidPartsTraceReadExitReasonsAndShareThroughTheFileProvider() throws {
        let kotlin = try sys15Source("Sources/Conclave/Skip/NativePerformanceDiagnostics.kt")
        #expect(kotlin.contains("Trace.beginAsyncSection(traceSectionName(name), cookie)"))
        #expect(kotlin.contains("Trace.endAsyncSection(traceSectionName(name), cookie)"))
        #expect(kotlin.contains("Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q"))
        #expect(kotlin.contains("manager.getHistoricalProcessExitReasons(context.packageName, 0, 5)"))
        #expect(kotlin.contains("manager.setProcessStateSummary(processStateSummary(callSession, phase))"))
        #expect(kotlin.contains("info.reason == ApplicationExitInfo.REASON_ANR"))
        #expect(kotlin.contains("ByteArray(DiagnosticsLimits.anrTraceBytes)"))
        #expect(kotlin.contains("DiagnosticsPayloadFactory.exitRecord("))
        // Exit reasons are read off the main thread, once.
        let install = try sys15Body(kotlin, from: "fun installDiagnosticsListeners(store: DiagnosticsFileStore) {",
                                    to: "private fun enableDebugStrictMode()")
        #expect(install.contains("if (diagnosticsListenersInstalled) return"))
        #expect(install.contains("Thread {\n                collectExitReasons(context, store)"))
        #expect(install.contains("if (AndroidRuntimeConfig.isDebuggable()) {\n                enableDebugStrictMode()"))
        #expect(install.contains("ProcessLifecycleOwner.get().lifecycle.addObserver(backgroundObserver)"))
        #expect(kotlin.contains("Lifecycle.Event.ON_STOP") && kotlin.contains("CallDiagnostics.shared.applicationDidEnterBackground()"))
        #expect(kotlin.contains("StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().build()"))
        #expect(kotlin.contains("StrictMode.VmPolicy.Builder().detectAll().penaltyLog().build()"))
        // The slow-frame monitor stays verbose-only; its counts join the export.
        #expect(kotlin.contains("if (verboseLogsEnabled()) {\n            startSlowFrameMonitor()\n        }"))
        #expect(kotlin.contains("verySlowFrames.incrementAndGet() else slowFrames.incrementAndGet()"))
        // The share: FileProvider URI, read grant, JSON, chooser title, PiP suppression.
        #expect(kotlin.contains("FileProvider.getUriForFile(context, context.packageName + FILE_PROVIDER_SUFFIX, file)"))
        #expect(kotlin.contains("type = \"application/json\"") && kotlin.contains("addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)"))
        #expect(kotlin.contains("Intent.createChooser(buildDiagnosticsSendIntent(uri, title), title)"))
        #expect(kotlin.contains("PipManager.suppressNextAutoEnter(\"diagnostics_share\")"))
        // The row: a clickable ListItem with the button role, the footer as supporting text, no trailing glyph.
        let item = try sys15Body(kotlin, from: "internal fun DiagnosticsExportItem(", to: "internal fun DiagnosticsExportEffects(")
        #expect(item.contains("clickable(enabled = !exporting, role = Role.Button)"))
        #expect(item.contains("conclaveString(\"sys_diag_export\")") && item.contains("conclaveString(\"sys_diag_footer\")"))
        #expect(!item.contains("trailingContent"))
        let effects = try sys15Body(kotlin, from: "internal fun DiagnosticsExportEffects(", to: "\n}\n")
        #expect(effects.contains("conclaveString(\"sys_diag_failed\")") && effects.contains("conclaveString(\"ds_retry\")"))
        #expect(effects.contains("conclaveString(\"sys_diag_share_title\")"))
        #expect(effects.contains("snackbar.showSnackbar(message = failure, actionLabel = retry"))
        // Logs are verbose-only and carry codes.
        #expect(kotlin.contains("if (!verboseLogsEnabled()) return\n        Log.i(DIAG_TAG, \"$category $code phase=$phase\")"))
    }

    @Test func theExportFolderIsInsideTheFileProviderExportsPath() throws {
        let paths = try sys15Source("Android/app/src/main/res/xml/conclave_file_paths.xml")
        #expect(paths.contains("<cache-path name=\"exports\" path=\"exports/\" />"))
        let store = try sys15Source("Sources/Conclave/Core/Diagnostics/DiagnosticsFileStore.swift")
        #expect(store.contains("URL.cachesDirectory\n            .appendingPathComponent(\"exports\", isDirectory: true)"))
        let manifest = try sys15Source("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android:authorities=\"${applicationId}.fileprovider\""))
    }

    @Test func ownedFilesKeepTheTranspileDesignAndPrivacyRules() throws {
        let shared = [
            "Sources/Conclave/Core/Diagnostics/DiagnosticsModels.swift",
            "Sources/Conclave/Core/Diagnostics/DiagnosticsPolicies.swift",
            "Sources/Conclave/Core/Diagnostics/DiagnosticsFileStore.swift",
            "Sources/Conclave/Core/Diagnostics/CallDiagnostics.swift",
            "Sources/Conclave/Core/Diagnostics/DiagnosticsExportPresenter.swift",
        ]
        let sources = shared + [
            "Sources/Conclave/Core/Diagnostics/CallDiagnostics+iOS.swift",
            "Sources/Conclave/Core/Diagnostics/DiagnosticsExportRow+iOS.swift",
            "Sources/Conclave/Shared/PerformanceDiagnostics.swift",
            "Sources/Conclave/Skip/NativePerformanceDiagnostics.kt",
        ]
        let tests = ["Tests/ConclaveTests/SYS15DiagnosticsTests.swift", "Tests/ConclaveTests/Skip/SYS15DiagnosticsBridgeTests.kt"]
        for file in sources + tests {
            let text = try sys15Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has a dash")
        }
        for file in sources {
            let text = try sys15Source(file)
            #expect(!text.contains("Gradient") && !text.contains("Color(0x"), "\(file)")
        }
        for file in shared {
            let text = try sys15Source(file)
            // Skip Lite: no UI import, no inout, no function-reference maps, no isLetter; S70 O8: no network client.
            for forbidden in ["import UIKit", "import SwiftUI", "inout ", ".map(String.init)", "compactMap(", "isLetter",
                              "indirect ", "URLSession", "URLRequest", "OkHttp"] {
                #expect(!text.contains(forbidden), "\(file) uses \(forbidden)")
            }
        }
        // S70 O8: nothing in the diagnostics folder talks to a network.
        let kotlin = try sys15Source("Sources/Conclave/Skip/NativePerformanceDiagnostics.kt")
        for forbidden in ["OkHttp", "HttpURLConnection", "URL(\"http", "PostHog", "posthog"] {
            #expect(!kotlin.contains(forbidden), "\(forbidden)")
        }
        // Identifiers in the perf logs stay private; names stay public.
        let perf = try sys15Source("Sources/Conclave/Shared/PerformanceDiagnostics.swift")
        #expect(perf.contains("\\(details, privacy: .private)") && !perf.contains("\\(details, privacy: .public)"))
        #expect(perf.contains("CallDiagnostics.shared.install()"))
        #expect(perf.contains("DiagnosticsTimingBridge.milestone(forTiming: name)"))
    }

    /// HD/strings/B7-T4.json merged by the integrator (fails until the merge).
    @Test func diagnosticsStringsAreInBothCatalogs() throws {
        let catalog = try sys15Source("Sources/Conclave/Resources/Localizable.xcstrings")
        for key in ["Export Diagnostics", "Creates a file without names, messages or meeting codes that you can send to support.",
                    "Conclave diagnostics", "Couldn\u{2019}t create the diagnostics file.", "Try Again"] {
            #expect(catalog.contains("\"\(key)\" : {"), "\(key)")
        }
        let strings = try sys15Source("Android/app/src/main/res/values/strings.xml")
        for name in ["sys_diag_export", "sys_diag_footer", "sys_diag_share_title", "sys_diag_failed", "ds_retry"] {
            #expect(strings.contains("<string name=\"\(name)\">"), "\(name)")
        }
    }

    /// The hooks HD/requests/B7-T4.md asks other owners for (fail until the batch 7 integrator applies them).
    @Test func requestedHooksAreWired() throws {
        let viewModel = try sys15Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(viewModel.contains("CallDiagnostics.shared.makePresenceAdapter()"))
        #expect(viewModel.contains("CallDiagnostics.shared.sensitiveValues = {"))
        #expect(viewModel.contains("canExportDiagnostics: DiagnosticsExportPolicy.isOffered"))
        #expect(viewModel.contains("CallDiagnostics.shared.recordFailure(classified)"))
        let settingsIOS = try sys15Source("Sources/Conclave/Features/Meeting/Settings/SettingsPanel+iOS.swift")
        #expect(settingsIOS.contains("DiagnosticsExportRow(presenter: DiagnosticsExportPresenter.shared)"))
        let rows = try sys15Source("Sources/Conclave/Skip/ui/settings/SettingsRows.kt")
        #expect(rows.contains("SettingsRowID.exportDiagnostics -> DiagnosticsExportItem(DiagnosticsExportPresenter.shared, tag)"))
        #expect(rows.contains("DiagnosticsExportEffects(DiagnosticsExportPresenter.shared, snackbar)"))
        let appScope = try sys15Source("Sources/Conclave/Skip/ui/settings/SettingsPanel.kt")
        #expect(appScope.contains("canExportDiagnostics = DiagnosticsExportPolicy.isOffered"))
        let account = try sys15Source("Sources/Conclave/Features/Account/AccountView+iOS.swift")
        #expect(account.contains("canExportDiagnostics: DiagnosticsExportPolicy.isOffered"))
    }
}

private func sys15PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys15Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys15PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private struct SYS15SourceRangeMissing: Error {
    let marker: String
}

/// The text between `start` and the first `end` after it.
private func sys15Body(_ source: String, from start: String, to end: String) throws -> String {
    guard let startRange = source.range(of: start) else { throw SYS15SourceRangeMissing(marker: start) }
    guard let endRange = source.range(of: end, range: startRange.upperBound..<source.endIndex) else {
        throw SYS15SourceRangeMissing(marker: end)
    }
    return String(source[startRange.upperBound..<endRange.lowerBound])
}
#endif
