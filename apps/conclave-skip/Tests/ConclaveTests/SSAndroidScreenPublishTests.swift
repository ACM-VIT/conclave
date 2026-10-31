#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct SSAndroidScreenPublishTests {

    @Test func screenProducesFollowTheRouterCodecInsteadOfVP8() throws {
        let source = try ssAndroidSource("Sources/Conclave/Skip/WebRTCClient+Android.kt")
        let start = ssAndroidBody("internal suspend fun startScreenSharing()", in: source)
        let refresh = ssAndroidBody("internal suspend fun refreshLocalScreenProducerForBandwidthProfile(", in: source)
        let produce = ssAndroidBody("private fun produceScreenVideo(", in: source)

        #expect(start.contains("produceScreenVideo(sendTransport, track, appData, currentLocalBandwidthQuality)"))
        #expect(refresh.contains("produceScreenVideo(transport, track, appData, connectionQuality)"))
        for body in [start, refresh, produce] {
            #expect(!body.isEmpty)
            #expect(!body.contains("preferredVideoCodecJson("))
        }
        #expect(produce.components(separatedBy: "transport.produce(").count - 1 == 2)
        #expect(produce.contains("if (screenProduceSignalCount != signalsBefore) throw t"))
        #expect(produce.contains("return requireRegisteredProducer(producer, \"screen\")"))

        let webcam = ssAndroidBody("private fun produceWebcamVideo(", in: source)
        #expect(webcam.contains("preferredVideoCodecJson()"))
    }

    @Test func qualityChangesNeverRecreateTheProjectionDisplay() throws {
        let source = try ssAndroidSource("Sources/Conclave/Skip/WebRTCClient+Android.kt")
        #expect(!source.contains("screenCapturer?.changeCaptureFormat"))
        #expect(!source.contains("screenCapturer.changeCaptureFormat"))
        #expect(source.contains("source.adaptOutputFormat(capture.width, capture.height, capture.maxFramerate)"))

        let start = ssAndroidBody("internal suspend fun startScreenSharing()", in: source)
        #expect(start.contains("ConnectionQuality.good,"))
        #expect(start.contains("applyScreenOutputFormat(currentLocalBandwidthQuality)"))
        let refresh = ssAndroidBody("internal suspend fun refreshLocalScreenProducerForBandwidthProfile(", in: source)
        #expect(refresh.contains("applyScreenOutputFormat(connectionQuality)"))
    }

    @Test func aRefreshedScreenProducerIsNotMistakenForAHostStop() throws {
        let source = try ssAndroidSource("Sources/Conclave/Skip/WebRTCClient+Android.kt")
        let refresh = ssAndroidBody("internal suspend fun refreshLocalScreenProducerForBandwidthProfile(", in: source)
        let marker = refresh.range(of: "intentionalLocalScreenProducerCloseIds.add(oldProducer.id)")
        let create = refresh.range(of: "produceScreenVideo(transport, track, appData, connectionQuality)")
        #expect(marker != nil && create != nil && marker!.lowerBound < create!.lowerBound)
        #expect(refresh.contains("if (screenProducer !== oldProducer || screenVideoTrack !== track) {"))

        let close = ssAndroidBody("internal suspend fun closeLocalMedia(", in: source)
        let consume = close.range(of: "intentionalLocalScreenProducerCloseIds.remove(producerId)")
        let stop = close.range(of: "matchesProducer(screenProducer, producerId)")
        #expect(consume != nil && stop != nil && consume!.lowerBound < stop!.lowerBound)
    }

    @Test func theFailureKeepsItsCauseAndLeavesAReleaseTrace() throws {
        let source = try ssAndroidSource("Sources/Conclave/Skip/WebRTCClient+Android.kt")
        #expect(source.contains("throw ErrorException(\"Screen sharing failed to start: ${reported}\", reported)"))
        #expect(source.contains("ScreenShareAndroidLog.warn(\"produce\", reported)"))
        let onProduce = ssAndroidBody("override fun onProduce(", in: source)
        #expect(onProduce.contains("lastScreenProducerSignalingError = t"))
        #expect(onProduce.contains("screenProduceSignalCount += 1"))

        let capture = try ssAndroidSource("Sources/Conclave/Skip/ScreenCaptureManager.kt")
        #expect(capture.contains("internal object ScreenShareAndroidLog {"))
        #expect(capture.contains("const val TAG = \"ConclaveShare\""))
        for branch in ["serviceRefused", "noActivity", "noLauncher", "blockedByPolicy", "noProjectionService", "launchThrew"] {
            #expect(capture.contains("\"\(branch)\""), "\(branch)")
        }
        let service = try ssAndroidSource("Sources/Conclave/Skip/ScreenCaptureService.kt")
        #expect(service.contains("ScreenShareAndroidLog.warn(\"foregroundRefused\", t)"))
    }

    @Test func theTouchedFilesStayDashFree() throws {
        for path in [
            "Sources/Conclave/Skip/WebRTCClient+Android.kt",
            "Sources/Conclave/Skip/ScreenCaptureManager.kt",
            "Sources/Conclave/Skip/ScreenCaptureService.kt",
        ] {
            let text = try ssAndroidSource(path)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(path)")
        }
    }
}

private func ssAndroidSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func ssAndroidBody(_ signature: String, in text: String) -> String {
    guard let start = text.range(of: signature) else { return "" }
    let rest = text[start.lowerBound...]
    guard let end = rest.range(of: "\n    }\n") else { return String(rest) }
    return String(rest[..<end.upperBound])
}
#endif
