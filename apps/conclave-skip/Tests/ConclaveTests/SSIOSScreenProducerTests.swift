#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct SSIOSScreenProducerTests {
    private static let clientFile = "Sources/Conclave/Core/WebRTC/WebRTCClient.swift"
    private static let testFile = "Tests/ConclaveTests/SSIOSScreenProducerTests.swift"

    @Test func theScreenProducerNeverAsksForAScalabilityMode() throws {
        let client = try ssiospSource(Self.clientFile)
        #expect(!client.contains("screenShareScalabilityMode"))
        #expect(!client.contains("scalabilityMode: request.scalabilityMode"))
        #expect(!client.contains("L1T\\("))
        let calls = ssiospArgumentLists(of: "createProducer(", in: client)
        #expect(calls.count == 2, "only the two off-main helpers create producers")
        for call in calls {
            #expect(!call.contains("scalabilityMode:"), "a createProducer call still passes a scalability mode: \(call)")
        }
        let request = try ssiospSlice(client, from: "private struct ScreenProducerCreationRequest: @unchecked Sendable {", to: "}")
        #expect(!request.contains("scalabilityMode"))
        #expect(!request.contains("let encoding: RTCRtpEncodingParameters"))
        #expect(request.contains("let encodings: [RTCRtpEncodingParameters]"))
        #expect(client.contains("private struct ScreenProducerCreationResult: @unchecked Sendable {"))
    }

    @Test func theOffMainScreenHelperUsesTheEncodingsOverloadOnTheSendQueue() throws {
        let client = try ssiospSource(Self.clientFile)
        let helper = ssiospFlat(try ssiospSlice(client, from: "private func createScreenProducerOffMain(", to: "private func createProducerOffMain("))
        #expect(helper.contains("private func createScreenProducerOffMain( on transport: SendTransport, track: RTCVideoTrack, "
                                + "encodings: [RTCRtpEncodingParameters], codec: String?, appData: String ) async throws -> Producer {"))
        #expect(helper.contains("let result = try await performSendTransportOperation(on: queue) { ScreenProducerCreationResult( "
                                + "producer: try request.transport.createProducer( for: request.track, encodings: request.encodings, "
                                + "codecOptions: nil, codec: request.codec, appData: request.appData ) ) }"))
        #expect(helper.contains("return try requireRegisteredProducer(result.producer, label: \"screen\", queue: queue)"))
        #expect(ssiospCount(client, ".createProducer(") == 2)
        #expect(ssiospCount(client, "request.transport.createProducer(") == 2)
        #expect(!client.contains("Task.detached(priority: .userInitiated) {\n            ScreenProducerCreationResult"))
    }

    @Test func bothScreenProducerSitesPassTheScreenEncodingsAndThePreferredCodec() throws {
        let client = try ssiospSource(Self.clientFile)
        let start = ssiospFlat(try ssiospSlice(client, from: "func startScreenSharing() async throws {", to: "func stopScreenSharing() async {"))
        let refresh = ssiospFlat(try ssiospSlice(client, from: "func refreshLocalScreenProducerForBandwidthProfile(",
                                                 to: "private func shouldRefreshAudioProducerForBandwidthProfile("))
        #expect(start.contains("let producer = try await createScreenProducerOffMain( on: sendTransport, track: screenTrack, "
                               + "encodings: screenShareEncodings( connectionQuality: currentLocalBandwidthQuality ), "
                               + "codec: preferredVideoCodecJSON(), appData: appData )"))
        #expect(refresh.contains("let producer = try await createScreenProducerOffMain( on: sendTransport, track: screenTrack, "
                                 + "encodings: screenShareEncodings(connectionQuality: connectionQuality), "
                                 + "codec: preferredVideoCodecJSON(), appData: appData )"))
        #expect(ssiospCount(client, "encodings: screenShareEncodings(") == 2)
        #expect(ssiospCount(client, "createScreenProducerOffMain(") == 3, "one definition and two call sites")
        #expect(!start.contains("encoding: screenShareEncoding("))
        #expect(!refresh.contains("encoding: screenShareEncoding("))
    }

    @Test func theRefreshMarksThePredecessorBeforeTheCreateAndFencesTheCommit() throws {
        let client = try ssiospSource(Self.clientFile)
        #expect(client.contains("private var intentionalLocalScreenProducerCloseIds: Set<String> = []"))
        let refresh = try ssiospSlice(client, from: "func refreshLocalScreenProducerForBandwidthProfile(",
                                      to: "private func shouldRefreshAudioProducerForBandwidthProfile(")
        try ssiospAssertOrder(refresh, [
            "lastScreenProducerSignalingError = nil",
            "if intentionalLocalScreenProducerCloseIds.count >= 32 {",
            "intentionalLocalScreenProducerCloseIds.removeAll()",
            "intentionalLocalScreenProducerCloseIds.insert(oldProducer.id)",
            "let producer = try await createScreenProducerOffMain(",
            "guard screenProducer === oldProducer, rtcScreenTrack === screenTrack else {",
            "try? await socketManager.closeProducer(producerId: producer.id)",
            "closeSendProducer(producer)",
            "return",
            "producer.delegate = self",
            "screenProducer = producer",
            "try await socketManager.closeProducer(producerId: oldProducer.id)",
            "closeSendProducer(oldProducer)",
            "} catch {",
            "intentionalLocalScreenProducerCloseIds.remove(oldProducer.id)"
        ], "screen bandwidth refresh")
        let fence = try ssiospSlice(refresh, from: "guard screenProducer === oldProducer, rtcScreenTrack === screenTrack else {",
                                    to: "producer.delegate = self")
        #expect(!fence.contains("producer.close()"), "the uncommitted replacement closes on the send queue")
        #expect(!fence.contains("screenProducer = "), "a superseded refresh commits nothing")
        #expect(!refresh.contains("producer.close()"))
        #expect(!refresh.contains("oldProducer.close()"))
    }

    @Test func closeLocalMediaConsumesTheScreenMarkerBeforeMatchingTheLiveProducer() throws {
        let client = try ssiospSource(Self.clientFile)
        let close = try ssiospSlice(client, from: "func closeLocalMedia(kind: String, type: String, producerId: String?) async -> Bool {",
                                    to: "private func matchesProducer(")
        let marker = try #require(close.range(of: "intentionalLocalScreenProducerCloseIds.remove(producerId) != nil"))
        let match = try #require(close.range(of: "matchesProducer(screenProducer"))
        #expect(marker.upperBound <= match.lowerBound)
        #expect(ssiospFlat(close).contains("if kind == \"video\", isScreen, let producerId, "
                                           + "intentionalLocalScreenProducerCloseIds.remove(producerId) != nil { return false }"))
        #expect(close.contains("if kind == \"video\", isScreen, matchesProducer(screenProducer, producerId: producerId) {"))
    }

    @Test func theScreenMarkerIsClearedWithTheAudioMarker() throws {
        let client = try ssiospSource(Self.clientFile)
        let configure = try ssiospSlice(client, from: "func configure(socketManager: SocketIOManager", to: "func createTransports() async throws {")
        #expect(ssiospFlat(configure).contains("intentionalLocalAudioProducerCloseIds.removeAll() intentionalLocalScreenProducerCloseIds.removeAll()"))
        #expect(ssiospFlat(client).contains("screenBandwidthRefreshInFlight = false intentionalLocalAudioProducerCloseIds.removeAll() "
                                            + "intentionalLocalScreenProducerCloseIds.removeAll()"))
        #expect(ssiospCount(client, "intentionalLocalScreenProducerCloseIds.removeAll()") == 3)
        #expect(ssiospCount(client, "intentionalLocalScreenProducerCloseIds.insert(") == 1)
    }

    @Test func onProduceKeepsTheSfuErrorForAScreenProducer() throws {
        let client = try ssiospSource(Self.clientFile)
        #expect(client.contains("private var lastScreenProducerSignalingError: Error?"))
        let produce = try ssiospSlice(client, from: "nonisolated func onProduce(", to: "nonisolated func onProduceData(")
        try ssiospAssertOrder(produce, [
            "} catch {",
            "if generation == self.configurationGeneration,",
            "transport === self.sendTransport,",
            "kind == .video {",
            "if failedType == ProducerType.webcam.rawValue {",
            "self.lastWebcamProducerSignalingError = error",
            "} else if failedType == ProducerType.screen.rawValue {",
            "self.lastScreenProducerSignalingError = error",
            "callback(nil)"
        ], "onProduce failure")
    }

    @Test func startScreenSharingRethrowsTheSfuErrorAfterItsCleanup() throws {
        let client = try ssiospSource(Self.clientFile)
        let start = try ssiospSlice(client, from: "func startScreenSharing() async throws {", to: "func stopScreenSharing() async {")
        try ssiospAssertOrder(start, [
            "lastScreenProducerSignalingError = nil",
            "try await createSendTransportIfNeeded()",
            "let producer = try await createScreenProducerOffMain(",
            "screenProducer = producer",
            "debugLog(\"[WebRTC] Screen sharing producer created:",
            "} catch {",
            "rtcScreenTrack = nil",
            "screenProducer = nil",
            "resetScreenFrameLimiter()",
            "throw lastScreenProducerSignalingError ?? error"
        ], "screen share start")
        #expect(!start.contains("throw error\n"))
        #expect(!start.contains("applyLocalBandwidthProfile"))
    }

    @Test func theOwnedFilesStayDashFree() throws {
        let dashes = ["\u{2013}", "\u{2014}"]
        for path in [Self.clientFile, Self.testFile] {
            let text = try ssiospSource(path)
            for dash in dashes {
                #expect(!text.contains(dash), "\(path) contains a banned dash")
            }
        }
    }
}

private func ssiospRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func ssiospSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: ssiospRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func ssiospFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func ssiospCount(_ text: String, _ needle: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

private func ssiospSlice(_ text: String, from start: String, to end: String) throws -> String {
    let startRange = try #require(text.range(of: start), "missing \(start)")
    let endRange = try #require(text.range(of: end, range: startRange.upperBound..<text.endIndex), "missing \(end) after \(start)")
    return String(text[startRange.lowerBound..<endRange.lowerBound])
}

private func ssiospArgumentLists(of call: String, in text: String) -> [String] {
    var result: [String] = []
    var cursor = text.startIndex
    while let open = text.range(of: call, range: cursor..<text.endIndex) {
        guard let close = text.range(of: ")", range: open.upperBound..<text.endIndex) else { break }
        let preceding: Character = open.lowerBound > text.startIndex ? text[text.index(before: open.lowerBound)] : " "
        if preceding == "." {
            result.append(String(text[open.upperBound..<close.lowerBound]))
        }
        cursor = open.upperBound
    }
    return result
}

private func ssiospAssertOrder(_ text: String, _ needles: [String], _ label: String) throws {
    var cursor = text.startIndex
    for needle in needles {
        let found = try #require(text.range(of: needle, range: cursor..<text.endIndex), "\(label): missing \(needle) in order")
        cursor = found.upperBound
    }
}
#endif
